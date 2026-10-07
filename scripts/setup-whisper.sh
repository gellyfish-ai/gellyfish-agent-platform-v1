#!/bin/bash
# Setup whisper.cpp for local voice transcription.
# Run this on any new machine to enable voice input in the gateway.

set -euo pipefail

WHISPER_SRC="${HOME}/.local/src/whisper.cpp"
WHISPER_MODEL_DIR="${HOME}/.local/share/whisper"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin"

echo "=== Whisper.cpp Setup ==="

# 1. Check ffmpeg
if ! command -v ffmpeg &>/dev/null; then
  echo "ERROR: ffmpeg not found. Install with: brew install ffmpeg"
  exit 1
fi
echo "✓ ffmpeg found: $(which ffmpeg)"

# 2. Clone and build whisper.cpp
if [ -f "${WHISPER_SRC}/build/bin/whisper-cli" ]; then
  echo "✓ whisper-cli already built at ${WHISPER_SRC}/build/bin/whisper-cli"
else
  echo "Building whisper.cpp from source..."
  mkdir -p "$(dirname "$WHISPER_SRC")"
  if [ ! -d "$WHISPER_SRC" ]; then
    git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git "$WHISPER_SRC"
  fi
  cd "$WHISPER_SRC"
  cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_METAL=ON
  cmake --build build -j"$(sysctl -n hw.ncpu)"
  echo "✓ whisper-cli built at ${WHISPER_SRC}/build/bin/whisper-cli"
fi

# 3. Download medium model
mkdir -p "$WHISPER_MODEL_DIR"
if [ -f "${WHISPER_MODEL_DIR}/ggml-medium.bin" ]; then
  echo "✓ Medium model already at ${WHISPER_MODEL_DIR}/ggml-medium.bin"
else
  echo "Downloading ggml-medium model (1.5GB)..."
  curl -L -o "${WHISPER_MODEL_DIR}/ggml-medium.bin" "$MODEL_URL"
  echo "✓ Model downloaded"
fi

# 4. Verify
echo ""
echo "=== Verification ==="
echo "Binary:  ${WHISPER_SRC}/build/bin/whisper-cli"
echo "Model:   ${WHISPER_MODEL_DIR}/ggml-medium.bin"
echo "ffmpeg:  $(which ffmpeg)"
echo ""
echo "Gateway env vars (optional, these are the defaults):"
echo "  WHISPER_BIN=${WHISPER_SRC}/build/bin/whisper-cli"
echo "  WHISPER_MODEL=${WHISPER_MODEL_DIR}/ggml-medium.bin"
echo ""
echo "=== Setup complete ==="
