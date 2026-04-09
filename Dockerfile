FROM node:24-alpine

WORKDIR /app

# 安裝 frpc
RUN apk add --no-cache curl tar \
    && curl -fSL https://github.com/fatedier/frp/releases/download/v0.68.0/frp_0.68.0_linux_amd64.tar.gz -o frp.tar.gz \
    && tar -xzf frp.tar.gz --strip-components=1 -C /usr/local/bin/ frp_0.68.0_linux_amd64/frpc \
    && rm frp.tar.gz

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./

RUN mkdir -p conf.d

EXPOSE 9090

COPY start.sh ./
RUN chmod +x start.sh

CMD ["./start.sh"]
