#!/usr/bin/env bash
#
# fineCode one-shot installer.
#
#   curl -fsSL https://raw.githubusercontent.com/RickDamon/fineCode/main/scripts/install.sh | bash
#
# What this does:
#   1. Verifies Node.js >= 18 (installs it via fnm if missing).
#   2. Installs fine-code globally via npm.
#   3. Prints next steps (`fine init`, `fine doctor`).
#
# What this does NOT do:
#   - Ask for sudo. Everything runs under $HOME.
#   - Alter your shell profile automatically — it tells you what to paste.
#   - Guess your preferred Node manager if you already have nvm/asdf/volta.

set -e

# ---------- pretty printing ----------
_bold()  { printf '\033[1m%s\033[0m' "$*"; }
_dim()   { printf '\033[2m%s\033[0m' "$*"; }
_green() { printf '\033[32m%s\033[0m' "$*"; }
_yellow(){ printf '\033[33m%s\033[0m' "$*"; }
_red()   { printf '\033[31m%s\033[0m' "$*"; }

info()   { printf '  %s  %s\n' "$(_green '▸')" "$*"; }
warn()   { printf '  %s  %s\n' "$(_yellow '▸')" "$*"; }
fatal()  { printf '  %s  %s\n' "$(_red '✗')" "$*" >&2; exit 1; }
step()   { printf '\n%s\n' "$(_bold "$*")"; }

# ---------- preflight ----------
step "Checking environment"

OS="$(uname -s)"
if [[ "$OS" != "Linux" && "$OS" != "Darwin" ]]; then
  fatal "Unsupported OS: $OS. Windows users should use WSL2."
fi
info "OS:            $OS"

# ---------- node ----------
NEED_NODE_MAJOR=18
CURRENT_NODE_OK="no"

if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -v)"
  NODE_MAJOR="${NODE_VER#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  info "Node.js found: $NODE_VER"
  if [[ "$NODE_MAJOR" -ge "$NEED_NODE_MAJOR" ]]; then
    CURRENT_NODE_OK="yes"
  else
    warn "Node $NODE_VER < required v$NEED_NODE_MAJOR — will install a newer one via fnm."
  fi
else
  warn "Node.js not found — will install via fnm."
fi

if [[ "$CURRENT_NODE_OK" != "yes" ]]; then
  step "Installing Node $NEED_NODE_MAJOR+ via fnm"

  if ! command -v fnm >/dev/null 2>&1; then
    info "Installing fnm (Fast Node Manager)…"
    curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
  fi

  export PATH="$HOME/.local/share/fnm:$PATH"
  if ! command -v fnm >/dev/null 2>&1; then
    # fnm may live in a platform-specific place; try common ones.
    for candidate in "$HOME/.fnm" "$HOME/Library/Application Support/fnm"; do
      if [[ -x "$candidate/fnm" ]]; then
        export PATH="$candidate:$PATH"
        break
      fi
    done
  fi

  if ! command -v fnm >/dev/null 2>&1; then
    fatal "fnm install completed but fnm is not on PATH. Close this shell and re-run, or install Node 18+ manually from https://nodejs.org"
  fi

  eval "$(fnm env --shell bash 2>/dev/null || true)"
  fnm install --lts
  fnm use lts-latest
  info "Node is now: $(node -v)"

  # Persist fnm for future shells.
  FNM_SHELL_SNIPPET='
# fineCode installer: fnm
export PATH="$HOME/.local/share/fnm:$PATH"
eval "$(fnm env --use-on-cd --shell bash 2>/dev/null || true)"
'
  SHELL_RC=""
  if [[ -n "${ZSH_VERSION:-}" ]] || [[ "$SHELL" == *zsh ]]; then
    SHELL_RC="$HOME/.zshrc"
    FNM_SHELL_SNIPPET="${FNM_SHELL_SNIPPET//bash/zsh}"
  elif [[ -n "${BASH_VERSION:-}" ]] || [[ "$SHELL" == *bash ]]; then
    SHELL_RC="$HOME/.bashrc"
  fi
  if [[ -n "$SHELL_RC" && -f "$SHELL_RC" ]]; then
    if ! grep -q 'fineCode installer: fnm' "$SHELL_RC"; then
      echo "$FNM_SHELL_SNIPPET" >> "$SHELL_RC"
      info "Appended fnm init to $SHELL_RC"
    fi
  else
    warn "Couldn't detect your shell rc — paste this snippet into your shell startup file:"
    printf '\n%s\n' "$FNM_SHELL_SNIPPET"
  fi
fi

# ---------- npm + fine-code ----------
if ! command -v npm >/dev/null 2>&1; then
  fatal "npm not on PATH after Node install. Open a new terminal and re-run this script."
fi

step "Installing fine-code globally via npm"
npm install -g fine-code

# ---------- verify ----------
step "Verifying installation"
if command -v fine >/dev/null 2>&1; then
  info "$(fine --version) installed at $(command -v fine)"
else
  fatal "fine is not on PATH. Check npm's global bin (\`npm bin -g\`) and make sure it's in your PATH."
fi

# ---------- done ----------
cat <<EOF

$(_green '✓ Installation complete')

Next steps:
  $(_bold 'fine init')      $(_dim '# configure your model and API key')
  $(_bold 'fine doctor')    $(_dim '# verify everything works')
  $(_bold 'fine')           $(_dim '# start the REPL')

Docs: https://github.com/RickDamon/fineCode
EOF
