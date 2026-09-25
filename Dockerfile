FROM node:20-slim

# Instalar dependencias necesarias para Chromium/Baileys si fuera requerido
RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

ENV PORT=3005
EXPOSE 3005

CMD ["node", "server.js"]
