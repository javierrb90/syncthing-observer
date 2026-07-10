FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src

RUN mkdir -p /data \
    && chown -R node:node /app /data

USER node

ENV NODE_ENV=production
ENV STATE_FILE=/data/state.json

VOLUME ["/data"]

CMD ["node", "src/index.js"]
