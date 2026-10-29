FROM node:24-bookworm-slim

ENV NODE_ENV=production
ENV DATA_DIR=/data
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# The server creates /data on mount and drops root privileges after fixing
# ownership, because the Deplexo volume may arrive owned by root.
RUN mkdir -p /data

EXPOSE 3000
CMD ["node", "server.js"]
