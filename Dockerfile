FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/game.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
