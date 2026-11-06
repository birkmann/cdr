#!/usr/bin/env bash
# Install apt packages on a GitHub runner without hanging on a slow mirror.
#
# The runner's default mirror (azure.archive.ubuntu.com) sometimes trickles data
# slowly enough that apt's own timeouts never fire. Each attempt is capped with
# `timeout`; after the first stall we switch to the main Ubuntu archive.
# Recommended packages (GStreamer plugins etc.) are runtime-only and skipped.
set -euo pipefail

apt_opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Dpkg::Use-Pty=0)
mirrors=("" "http://archive.ubuntu.com/ubuntu" "http://mirrors.edge.kernel.org/ubuntu")

for i in "${!mirrors[@]}"; do
  mirror=${mirrors[$i]}
  if [[ -n $mirror ]]; then
    echo "::warning::apt attempt $i stalled or failed; switching to $mirror"
    sudo dpkg --configure -a || true
    for f in /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list; do
      if [[ -f $f ]]; then
        sudo sed -i -E "s#https?://[^ ]*archive\.ubuntu\.com/ubuntu/?#${mirror}#g" "$f"
      fi
    done
  fi
  if timeout 120 sudo apt-get "${apt_opts[@]}" update &&
     timeout 240 sudo apt-get "${apt_opts[@]}" install -y --no-install-recommends "$@"; then
    exit 0
  fi
done

echo "::error::apt-get install failed on every mirror"
exit 1
