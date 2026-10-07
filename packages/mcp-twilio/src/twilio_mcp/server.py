"""Gellyfish Twilio SMS MCP server. Forked from 0x-Professor/Twilio-mcp-server (MIT).

Removed: account resource (leaks Account SID to agents), prompts (agents handle this themselves).
Kept: all tools. Webhook/boot available separately via boot.py.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any

from fastmcp import FastMCP
from pydantic import AnyHttpUrl, BaseModel, ConfigDict, Field, field_validator, model_validator

from . import __version__
from . import client as twilio_client
from .config import E164_PATTERN, get_settings, setup_logging
from . import store

logger = logging.getLogger(__name__)

MESSAGE_SID_PATTERN = r"^SM[0-9A-Fa-f]{32}$"
PhoneNumber = Annotated[str, Field(pattern=E164_PATTERN)]
MessageSid = Annotated[str, Field(pattern=MESSAGE_SID_PATTERN)]

mcp = FastMCP(
    "gellyfish_twilio",
    instructions=(
        "Twilio SMS MCP for Gellyfish. "
        "Use sms_list_inbox to check incoming messages, sms_send to send, "
        "sms_get_conversation to review a thread, sms_usage_stats to check costs. "
        "All phone numbers must use E.164 format (e.g. +12025551234)."
    ),
)


def _json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, indent=2, default=str)


# --- Input models ---

class SendInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    to: PhoneNumber = Field(..., description="Recipient phone number in E.164 format.")
    body: str = Field(..., min_length=1, max_length=1600, description="Message text.")
    media_urls: list[AnyHttpUrl] | None = Field(default=None, max_length=10, description="Optional public media URLs for MMS.")


class SendBulkInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    to: list[PhoneNumber] = Field(..., min_length=1, max_length=100, description="Recipient phone numbers.")
    body: str = Field(..., min_length=1, max_length=1600, description="Message text.")

    @field_validator("to")
    @classmethod
    def _deduplicate_recipients(cls, recipients: list[str]) -> list[str]:
        if len(set(recipients)) != len(recipients):
            raise ValueError("Recipient list contains duplicate phone numbers.")
        return recipients


class ScheduleInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    to: PhoneNumber = Field(..., description="Recipient phone number in E.164 format.")
    body: str = Field(..., min_length=1, max_length=1600, description="Message text.")
    send_at: datetime = Field(..., description="ISO 8601 timestamp with timezone. Must be 15min-35days ahead.")

    @field_validator("send_at")
    @classmethod
    def _validate_send_at(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("send_at must include an explicit timezone.")
        send_at_utc = value.astimezone(timezone.utc)
        now = datetime.now(timezone.utc)
        if send_at_utc < now + timedelta(minutes=15):
            raise ValueError("send_at must be at least 15 minutes in the future.")
        if send_at_utc > now + timedelta(days=35):
            raise ValueError("send_at must be no more than 35 days in the future.")
        return send_at_utc


class SidInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    sid: MessageSid = Field(..., description="Twilio Message SID starting with 'SM'.")


class ListSentInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    to: PhoneNumber | None = Field(default=None, description="Optional recipient number filter.")
    from_: PhoneNumber | None = Field(default=None, alias="from", description="Optional sender number filter.")
    limit: int = Field(default=20, ge=1, le=100, description="Number of messages to return.")


class ListInboxInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    from_number: PhoneNumber | None = Field(default=None, description="Optional sender filter.")
    unread_only: bool = Field(default=False, description="Only include unread messages.")
    limit: int = Field(default=20, ge=1, le=100, description="Maximum records to return.")
    offset: int = Field(default=0, ge=0, description="Pagination offset.")


class ConversationInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    number: PhoneNumber = Field(..., description="Phone number to inspect in E.164 format.")
    limit: int = Field(default=50, ge=1, le=200, description="Maximum combined messages to return.")


class MarkReadInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sid: MessageSid | None = Field(default=None, description="Specific inbound message SID.")
    from_number: PhoneNumber | None = Field(default=None, description="Mark all messages from this sender as read.")

    @model_validator(mode="after")
    def _validate_filters(self) -> "MarkReadInput":
        if self.sid and self.from_number:
            raise ValueError("Provide either sid or from_number, not both.")
        return self


class LookupInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    phone_number: PhoneNumber = Field(..., description="Phone number to look up in E.164 format.")


class FormatNumberInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    phone_number: str = Field(..., min_length=3, max_length=20, description="Phone number in any format to validate and reformat to E.164.")
    country_code: str | None = Field(default=None, min_length=2, max_length=2, description="ISO 3166-1 alpha-2 country code (e.g. 'US').")


class UsageStatsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    category: str = Field(default="sms", description="Usage category: 'sms', 'sms-inbound', 'sms-outbound', 'mms', etc.")
    days: int = Field(default=30, ge=1, le=90, description="Number of recent days to retrieve.")


# --- Tools ---

@mcp.tool(name="sms_send", annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True})
async def sms_send(params: SendInput) -> str:
    """Send an SMS message."""
    try:
        message = await twilio_client.send_message(to=params.to, body=params.body, media_url=[str(u) for u in params.media_urls] if params.media_urls else None)
        return _json({"success": True, "sid": message["sid"], "to": message["to"], "from": message["from"], "status": message["status"], "date_created": message["date_created"]})
    except Exception as error:
        return _json({"success": False, "error": twilio_client.handle_error(error)})


@mcp.tool(name="sms_send_bulk", annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True})
async def sms_send_bulk(params: SendBulkInput) -> str:
    """Send the same SMS to multiple recipients. Requires TWILIO_MESSAGING_SERVICE_SID."""
    concurrency = get_settings().bulk_send_concurrency
    semaphore = asyncio.Semaphore(concurrency)

    async def _send_one(number: str) -> dict[str, Any]:
        async with semaphore:
            try:
                message = await twilio_client.send_message(to=number, body=params.body)
                return {"to": number, "success": True, "sid": message["sid"], "status": message["status"]}
            except Exception as error:
                return {"to": number, "success": False, "error": twilio_client.handle_error(error)}

    results = await asyncio.gather(*(_send_one(number) for number in params.to))
    succeeded = sum(1 for result in results if result["success"])
    return _json({"total": len(params.to), "succeeded": succeeded, "failed": len(params.to) - succeeded, "results": results})


@mcp.tool(name="sms_schedule", annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True})
async def sms_schedule(params: ScheduleInput) -> str:
    """Schedule an SMS for future delivery. Requires TWILIO_MESSAGING_SERVICE_SID."""
    try:
        message = await twilio_client.send_message(to=params.to, body=params.body, schedule_time=params.send_at)
        return _json({"success": True, "sid": message["sid"], "status": message["status"], "scheduled_for": params.send_at.isoformat(), "to": message["to"]})
    except Exception as error:
        return _json({"success": False, "error": twilio_client.handle_error(error)})


@mcp.tool(name="sms_list_sent", annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True})
async def sms_list_sent(params: ListSentInput) -> str:
    """List sent SMS messages."""
    try:
        messages = await twilio_client.list_sent_messages(to=params.to, from_=params.from_, limit=params.limit)
        return _json({"count": len(messages), "messages": messages})
    except Exception as error:
        return _json({"success": False, "error": twilio_client.handle_error(error)})


@mcp.tool(name="sms_list_inbox", annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False})
async def sms_list_inbox(params: ListInboxInput) -> str:
    """List incoming SMS messages."""
    store.init_db()
    messages = store.get_inbox(from_number=params.from_number, unread_only=params.unread_only, limit=params.limit, offset=params.offset)
    return _json({"unread_total": store.count_unread(), "count": len(messages), "offset": params.offset, "has_more": len(messages) == params.limit, "messages": messages})


@mcp.tool(name="sms_get_message", annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True})
async def sms_get_message(params: SidInput) -> str:
    """Fetch a specific message by SID."""
    try:
        store.init_db()
        message = await twilio_client.fetch_message(params.sid)
        latest_status = store.get_latest_delivery_status(params.sid)
        if latest_status:
            message["latest_delivery_status"] = latest_status
        return _json(message)
    except Exception as error:
        return _json({"success": False, "error": twilio_client.handle_error(error)})


def _conversation_sort_key(message: dict[str, Any]) -> datetime:
    for key in ("date_sent", "date_created", "received_at", "date_updated"):
        value = message.get(key)
        if value:
            normalized = str(value).replace("Z", "+00:00")
            parsed = datetime.fromisoformat(normalized)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
    return datetime.min.replace(tzinfo=timezone.utc)


@mcp.tool(name="sms_get_conversation", annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False})
async def sms_get_conversation(params: ConversationInput) -> str:
    """Get the full conversation thread with a phone number."""
    store.init_db()
    local_messages = store.get_conversation(number=params.number, limit=params.limit * 2)
    combined: dict[str, dict[str, Any]] = {str(message["sid"]): dict(message) for message in local_messages}

    try:
        twilio_messages = await twilio_client.list_conversation(number=params.number, limit=params.limit)
    except Exception as error:
        fallback_messages = sorted(combined.values(), key=_conversation_sort_key)[-params.limit:]
        return _json({"number": params.number, "count": len(fallback_messages), "messages": fallback_messages, "warning": twilio_client.handle_error(error)})

    read_statuses = store.get_read_statuses(message["sid"] for message in twilio_messages)
    for message in twilio_messages:
        sid = str(message["sid"])
        if sid in read_statuses:
            message["read"] = read_statuses[sid]
        elif sid in combined and "read" in combined[sid]:
            message["read"] = combined[sid]["read"]
        combined[sid] = {**combined.get(sid, {}), **message}

    messages = sorted(combined.values(), key=_conversation_sort_key)[-params.limit:]
    return _json({"number": params.number, "count": len(messages), "messages": messages})


@mcp.tool(name="sms_mark_read", annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False})
async def sms_mark_read(params: MarkReadInput) -> str:
    """Mark messages as read."""
    store.init_db()
    if params.sid:
        marked = store.mark_read(params.sid)
        return _json({"success": True, "marked": marked, "sid": params.sid})
    marked = store.mark_all_read(from_number=params.from_number)
    payload: dict[str, Any] = {"success": True, "marked": marked}
    if params.from_number:
        payload["from_number"] = params.from_number
    return _json(payload)


@mcp.tool(name="sms_delete_message", annotations={"readOnlyHint": False, "destructiveHint": True, "idempotentHint": True, "openWorldHint": True})
async def sms_delete_message(params: SidInput) -> str:
    """Delete a message from Twilio."""
    try:
        await twilio_client.delete_message(params.sid)
        return _json({"success": True, "sid": params.sid, "deleted": True})
    except Exception as error:
        return _json({"success": False, "error": twilio_client.handle_error(error)})


@mcp.tool(name="sms_redact_message", annotations={"readOnlyHint": False, "destructiveHint": True, "idempotentHint": True, "openWorldHint": True})
async def sms_redact_message(params: SidInput) -> str:
    """Redact the body of a message (Twilio keeps metadata but clears the text)."""
    try:
        message = await twilio_client.redact_message(params.sid)
        return _json({"success": True, "sid": message["sid"], "body": message["body"], "status": message["status"]})
    except Exception as error:
        return _json({"success": False, "error": twilio_client.handle_error(error)})


@mcp.tool(name="sms_cancel_scheduled", annotations={"readOnlyHint": False, "destructiveHint": True, "idempotentHint": True, "openWorldHint": True})
async def sms_cancel_scheduled(params: SidInput) -> str:
    """Cancel a scheduled message."""
    try:
        message = await twilio_client.cancel_message(params.sid)
        return _json({"success": True, "sid": message["sid"], "status": message["status"]})
    except Exception as error:
        return _json({"success": False, "error": twilio_client.handle_error(error)})


@mcp.tool(name="sms_list_numbers", annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True})
async def sms_list_numbers() -> str:
    """List phone numbers on the Twilio account."""
    try:
        numbers = await twilio_client.list_phone_numbers()
        return _json({"count": len(numbers), "numbers": numbers})
    except Exception as error:
        return _json({"success": False, "error": twilio_client.handle_error(error)})


@mcp.tool(name="sms_lookup_number", annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True})
async def sms_lookup_number(params: LookupInput) -> str:
    """Look up carrier and type information for a phone number."""
    try:
        result = await twilio_client.lookup_number(params.phone_number)
        return _json(result)
    except Exception as error:
        return _json({"success": False, "error": twilio_client.handle_error(error)})


@mcp.tool(name="sms_format_number", annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True})
async def sms_format_number(params: FormatNumberInput) -> str:
    """Validate a phone number and return its E.164 form."""
    try:
        result = await twilio_client.format_number(params.phone_number, country_code=params.country_code)
        return _json(result)
    except Exception as error:
        return _json({"success": False, "error": twilio_client.handle_error(error)})


@mcp.tool(name="sms_account_info", annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True})
async def sms_account_info() -> str:
    """Fetch account balance, status, and friendly name."""
    try:
        info = await twilio_client.get_account_info()
        return _json(info)
    except Exception as error:
        return _json({"success": False, "error": twilio_client.handle_error(error)})


@mcp.tool(name="sms_usage_stats", annotations={"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True})
async def sms_usage_stats(params: UsageStatsInput) -> str:
    """Retrieve daily SMS/MMS usage statistics for cost monitoring."""
    try:
        from decimal import Decimal
        records = await twilio_client.get_usage_records(category=params.category, days=params.days)
        total_count = sum(int(r.get("count") or 0) for r in records)
        total_price = sum(Decimal(r.get("price") or "0") for r in records)
        return _json({"category": params.category, "days": params.days, "total_messages": total_count, "total_cost": f"{total_price:.4f}", "currency": (records[0].get("price_unit") or "USD") if records else "USD", "daily_records": records})
    except Exception as error:
        return _json({"success": False, "error": twilio_client.handle_error(error)})


def main() -> None:
    settings = get_settings()
    setup_logging(settings.log_level)
    logger.info("Starting Gellyfish Twilio MCP server v%s", __version__)
    store.init_db()

    transport = settings.mcp_transport
    if transport in ("sse", "http"):
        logger.info("MCP %s transport on %s:%d", transport, settings.mcp_host, settings.mcp_port)
        mcp.run(transport=transport, host=settings.mcp_host, port=settings.mcp_port)
    else:
        logger.info("MCP stdio transport")
        mcp.run()


if __name__ == "__main__":
    main()
