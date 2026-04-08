FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./

RUN mkdir -p conf.d

EXPOSE 9090

CMD ["node", "server.js"]
