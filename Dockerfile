# Imagem de produção — Charão Gestão de Obras (sem dependências externas)
FROM node:24-slim
ENV NODE_ENV=production \
    PORT=10000 \
    DATA_DIR=/var/data
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
RUN mkdir -p /var/data
EXPOSE 10000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
