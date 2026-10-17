FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

ENV PORT=8080
# Custom-cue item store. Mount a volume here or items are lost on rebuild.
ENV DATA_DIR=/data
RUN mkdir -p /data
VOLUME /data
EXPOSE 8080

CMD ["node", "src/server.js"]
