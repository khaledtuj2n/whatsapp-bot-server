FROM node:18-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# تثبيت pm2 عالميًا والمكتبات اللازمة لـ Puppeteer
RUN npm install -g pm2
RUN apt-get update && apt-get install -y \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libxss1 \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 3000

CMD ["pm2-runtime", "server.js"]
