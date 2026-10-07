FROM python:3.12-slim

WORKDIR /app

# Install dependencies first for better layer caching
COPY pyproject.toml .
RUN pip install --no-cache-dir hatchling && \
    pip install --no-cache-dir .

# Copy source
COPY src/ src/

# Re-install with source for the entry point script
RUN pip install --no-cache-dir -e .

EXPOSE 8200

ENV MCP_TRANSPORT=sse
ENV MCP_PORT=8200
ENV MCP_HOST=0.0.0.0

CMD ["gellyfish-twilio-mcp"]
