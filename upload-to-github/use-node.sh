# Puts the project's bundled Node.js on PATH for this terminal session:
#   source ./use-node.sh
# Not needed if you have Node.js 22.13 or newer installed system-wide.
export PATH="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/.tools/node/bin:$PATH"
echo "Using Node $(node -v)"
