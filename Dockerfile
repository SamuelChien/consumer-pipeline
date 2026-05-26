FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production

COPY src/ src/
COPY scripts/ scripts/
COPY infra/ infra/

RUN mkdir -p /data/output

CMD ["node", "src/index.js"]
