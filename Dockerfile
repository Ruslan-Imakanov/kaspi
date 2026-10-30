FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DB_FILE=/data/kaspi.db PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "--no-warnings", "server/index.js"]
