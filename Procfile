FROM node:18

# تثبيت الـ dependencies اللازمة لـ puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# ضبط المسار بتاع Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# نسخ ملفات المشروع
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# تشغيل السيرفر
CMD ["npm", "start"]