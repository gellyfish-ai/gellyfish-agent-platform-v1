"""Async wrappers around the synchronous Twilio Python SDK with retry logic."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from twilio.base.exceptions import TwilioRestException
from twilio.rest import Client

from .config import get_settings

logger = logging.getLogger(__name__)

_client: Client | None = None

# Twilio error codes that are safe to retry (transient failures).
# These are 5-digit Twilio application error codes, NOT HTTP status codes.
_RETRYABLE_CODES: frozenset[int] = frozenset({20429, 20500, 20503})
_RETRYABLE_HTTP: frozenset[int] = frozenset({429, 500, 502, 503, 504})


def get_client() -> Client:
    global _client
    settings = get_settings()
    if _client is None:
        _client = Client(settings.account_sid, settings.auth_token.get_secret_value())
    return _client


async def _run_with_retry(fn, *args, **kwargs) -> Any:
    """Execute *fn* in a thread with exponential-backoff retry on transient errors."""
    settings = get_settings()
    max_attempts = settings.api_retry_attempts
    base_delay = settings.api_retry_delay

    last_error: Exception | None = None
    for attempt in range(max_attempts + 1):
        try:
            return await asyncio.to_thread(fn, *args, **kwargs)
        except TwilioRestException as exc:
            last_error = exc
            retryable = exc.code in _RETRYABLE_CODES or exc.status in _RETRYABLE_HTTP
            if not retryable or attempt >= max_attempts:
                raise
            delay = base_delay * (2 ** attempt)
            logger.warning(
                "Twilio API error %s (HTTP %s), retry %d/%d in %.1fs",
                exc.code, exc.status, attempt + 1, max_attempts, delay,
            )
            await asyncio.sleep(delay)
        except (ConnectionError, TimeoutError, OSError) as exc:
            last_error = exc
            if attempt >= max_attempts:
                raise
            delay = base_delay * (2 ** attempt)
            logger.warning(
                "Network error %s, retry %d/%d in %.1fs",
                type(exc).__name__, attempt + 1, max_attempts, delay,
            )
            await asyncio.sleep(delay)

    raise last_error  # type: ignore[misc]  # pragma: no cover


async def send_message(
    to: str,
    body: str,
    media_url: list[str] | None = None,
    schedule_time: datetime | None = None,
) -> dict[str, Any]:
    """Send an SMS or MMS message and return a normalized message payload."""
    settings = get_settings()
    client = get_client()
    params: dict[str, Any] = {"to": to, "body": body}

    if settings.messaging_service_sid:
        params["messaging_service_sid"] = settings.messaging_service_sid
    else:
        params["from_"] = settings.from_number

    if media_url:
        params["media_url"] = media_url

    if schedule_time:
        if not settings.messaging_service_sid:
            raise ValueError("Scheduling requires TWILIO_MESSAGING_SERVICE_SID to be set.")
        params["schedule_type"] = "fixed"
        params["send_at"] = schedule_time.astimezone(timezone.utc)

    logger.info("Sending message to %s", to)
    # Do NOT retry message creation — a timeout after Twilio accepts the
    # POST could result in duplicate messages being sent.
    message = await asyncio.to_thread(client.messages.create, **params)
    return _message_to_dict(message)


async def fetch_message(sid: str) -> dict[str, Any]:
    client = get_client()
    message = await _run_with_retry(client.messages(sid).fetch)
    return _message_to_dict(message)


async def list_messages(
    to: str | None = None,
    from_: str | None = None,
    limit: int = 20,
    page_size: int | None = None,
) -> list[dict[str, Any]]:
    client = get_client()
    kwargs: dict[str, Any] = {"limit": limit}
    if page_size is not None:
        kwargs["page_size"] = page_size
    if to:
        kwargs["to"] = to
    if from_:
        kwargs["from_"] = from_

    messages = await _run_with_retry(client.messages.list, **kwargs)
    return [_message_to_dict(message) for message in messages]


async def list_sent_messages(
    to: str | None = None,
    from_: str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    sample_size = min(max(limit * 5, limit), 500)
    messages = await list_messages(to=to, from_=from_, limit=sample_size, page_size=min(sample_size, 100))
    sent_messages = [message for message in messages if str(message.get("direction", "")).startswith("outbound")]
    return sent_messages[:limit]


async def list_conversation(number: str, limit: int = 50) -> list[dict[str, Any]]:
    sample_size = min(max(limit * 3, limit), 200)
    inbound, outbound = await asyncio.gather(
        list_messages(from_=number, limit=sample_size, page_size=min(sample_size, 100)),
        list_messages(to=number, limit=sample_size, page_size=min(sample_size, 100)),
    )

    deduped: dict[str, dict[str, Any]] = {}
    for message in inbound + outbound:
        deduped[message["sid"]] = message

    ordered = sorted(deduped.values(), key=_message_sort_key)
    return ordered[-limit:]


async def cancel_message(sid: str) -> dict[str, Any]:
    client = get_client()
    message = await _run_with_retry(client.messages(sid).update, status="canceled")
    return _message_to_dict(message)


async def delete_message(sid: str) -> bool:
    client = get_client()
    await _run_with_retry(client.messages(sid).delete)
    return True


async def redact_message(sid: str) -> dict[str, Any]:
    """Redact a message body by setting it to empty string (Twilio retains metadata)."""
    client = get_client()
    message = await _run_with_retry(client.messages(sid).update, body="")
    logger.info("Redacted message %s", sid)
    return _message_to_dict(message)


async def list_phone_numbers() -> list[dict[str, Any]]:
    client = get_client()
    numbers = await _run_with_retry(client.incoming_phone_numbers.list)
    results: list[dict[str, Any]] = []
    for number in numbers:
        capabilities = getattr(number, "capabilities", {}) or {}
        results.append(
            {
                "sid": number.sid,
                "phone_number": number.phone_number,
                "friendly_name": number.friendly_name,
                "capabilities": {
                    "sms": capabilities.get("sms"),
                    "mms": capabilities.get("mms"),
                    "voice": capabilities.get("voice"),
                },
                "sms_url": getattr(number, "sms_url", None),
                "status_callback": getattr(number, "status_callback", None),
                "date_created": str(number.date_created),
            }
        )
    return results


async def lookup_number(phone_number: str) -> dict[str, Any]:
    client = get_client()
    result = await _run_with_retry(
        client.lookups.v2.phone_numbers(phone_number).fetch,
        fields="line_type_intelligence",
    )
    return {
        "phone_number": result.phone_number,
        "country_code": result.country_code,
        "national_format": result.national_format,
        "valid": result.valid,
        "line_type_intelligence": result.line_type_intelligence,
    }


async def format_number(phone_number: str, country_code: str | None = None) -> dict[str, Any]:
    """Validate and return formatting details for a phone number."""
    client = get_client()
    kwargs: dict[str, Any] = {}
    if country_code:
        kwargs["country_code"] = country_code
    result = await _run_with_retry(
        client.lookups.v2.phone_numbers(phone_number).fetch,
        **kwargs,
    )
    return {
        "phone_number": result.phone_number,
        "country_code": result.country_code,
        "national_format": result.national_format,
        "valid": result.valid,
        "calling_country_code": getattr(result, "calling_country_code", None),
    }


async def get_account_info() -> dict[str, Any]:
    settings = get_settings()
    client = get_client()
    account, balance = await asyncio.gather(
        _run_with_retry(client.api.accounts(settings.account_sid).fetch),
        _run_with_retry(client.balance.fetch),
    )
    return {
        "account_sid": account.sid,
        "friendly_name": account.friendly_name,
        "status": account.status,
        "type": account.type,
        "balance": balance.balance,
        "currency": balance.currency,
    }


async def get_usage_records(category: str = "sms", days: int = 30) -> list[dict[str, Any]]:
    """Fetch recent usage records for the given category."""
    client = get_client()
    records = await _run_with_retry(
        client.usage.records.daily.list,
        category=category,
        limit=days,
    )
    return [
        {
            "category": str(record.category),
            "start_date": str(record.start_date),
            "end_date": str(record.end_date),
            "count": record.count,
            "count_unit": record.count_unit,
            "price": str(record.price) if record.price is not None else None,
            "price_unit": record.price_unit,
            "usage": record.usage,
            "usage_unit": record.usage_unit,
        }
        for record in records
    ]


def _message_to_dict(message) -> dict[str, Any]:
    return {
        "sid": message.sid,
        "to": message.to,
        "from": message.from_,
        "body": message.body,
        "status": message.status,
        "direction": message.direction,
        "num_segments": message.num_segments,
        "num_media": message.num_media,
        "price": str(message.price) if message.price is not None else None,
        "price_unit": message.price_unit,
        "date_created": str(message.date_created),
        "date_sent": str(message.date_sent) if message.date_sent else None,
        "date_updated": str(message.date_updated) if message.date_updated else None,
        "error_code": message.error_code,
        "error_message": message.error_message,
        "uri": message.uri,
    }


def _message_sort_key(message: dict[str, Any]) -> datetime:
    for key in ("date_sent", "date_created", "date_updated", "received_at"):
        value = message.get(key)
        if value:
            normalized = str(value).replace("Z", "+00:00")
            parsed = datetime.fromisoformat(normalized)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
    return datetime.min.replace(tzinfo=timezone.utc)


def handle_error(error: Exception) -> str:
    """Convert common exceptions into actionable messages for clients."""
    if isinstance(error, TwilioRestException):
        code = error.code
        if code == 20003:
            return "Error: Authentication failed. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN."
        if code == 21211:
            return "Error: Invalid 'to' phone number. Use E.164 format such as +12025551234."
        if code == 21214:
            return "Error: The destination number is not SMS-capable."
        if code == 21408:
            return "Error: Geographic permissions block this destination. Update Messaging geographic permissions in Twilio Console."
        if code == 21610:
            return "Error: The recipient has opted out with STOP."
        if code == 21612:
            return "Error: The configured sender cannot message this destination."
        if code == 21617:
            return "Error: Message body exceeds the 1,600 character Twilio limit."
        if code == 30006:
            return "Error: The destination carrier rejected the message."
        if error.status == 429:
            return "Error: Twilio rate limit reached. Retry with lower concurrency."
        return f"Error: Twilio error {code} - {error.msg}. See https://www.twilio.com/docs/errors/{code}"

    if isinstance(error, ValueError):
        return f"Error: {error}"

    return f"Error: Unexpected error - {type(error).__name__}: {error}"
