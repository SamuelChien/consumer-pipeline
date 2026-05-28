FROM node:18-alpine

WORKDIR /app

# Install tailscale
RUN apk add --no-cache curl iptables ip6tables \
    && curl -fsSL https://tailscale.com/install.sh | sh

COPY package.json package-lock.json* ./
RUN npm ci --production

COPY src/ src/
COPY scripts/ scripts/
COPY infra/ infra/

RUN mkdir -p /data/output

COPY <<'STARTSH' /app/start.sh
#!/bin/sh
set -e
if [ -n "$TS_AUTHKEY" ]; then
  tailscaled --tun=userspace-networking --state=/tmp/tailscale.state --socket=/tmp/tailscale.sock &
  sleep 2
  tailscale --socket=/tmp/tailscale.sock up --authkey="$TS_AUTHKEY" --hostname="consumer-pipeline" --accept-routes
  echo "Tailscale up as consumer-pipeline"
fi
exec node src/index.js
STARTSH
RUN chmod +x /app/start.sh

CMD ["/app/start.sh"]
