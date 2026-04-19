#!/usr/bin/env zsh

# --- ZSH PATH CHECK ---
export PATH="$HOME/.lmstudio/bin:$PATH"
[[ -f ~/.zshrc ]] && source ~/.zshrc

# --- CONFIGURATION ---
REAL_MODEL="mistralai_devstral-small-2-24b-instruct-2512-mlx"
LM_STUDIO_PORT=1234
PROXY_PORT=8082
PROXY_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- 1. START LM STUDIO ---
echo "⚙️  Initializing LM Studio..."
lms daemon up
lms load "$REAL_MODEL" --gpu 1.0 --context-length 65536 --yes
lms server start --port $LM_STUDIO_PORT

# --- 2. START CLAUDEPROXY ---
# Translates Anthropic API format to OpenAI format for LM Studio
echo "🌉 Starting claudeproxy on port $PROXY_PORT..."
pkill -f "node.*claudeproxy" || true
PORT=$PROXY_PORT \
  LM_STUDIO_URL="http://127.0.0.1:$LM_STUDIO_PORT" \
  node "$PROXY_DIR/index.js" > /tmp/claudeproxy.log 2>&1 &
sleep 1

# --- 3. CLAUDE ENVIRONMENT ---
# Point Claude to the proxy, not directly to LM Studio
export ANTHROPIC_BASE_URL="http://127.0.0.1:$PROXY_PORT"
export ANTHROPIC_API_KEY="lm-studio"
export ANTHROPIC_API_VERSION="2023-06-01"
export CLAUDE_CODE_SKIP_METADATA_CHECK=true
# Bypass Claude's hardcoded model list — passes the model name through as-is
export ANTHROPIC_CUSTOM_MODEL_OPTION="$REAL_MODEL"

# --- 4. LAUNCH ---
echo "🚀 Launching Claude Code (M4 Optimized)..."
if command -v claude &> /dev/null; then
    claude --debug
else
    open -a "Claude" .
fi
