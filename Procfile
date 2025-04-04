FROM node:18-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# تثبيت pm2 عالميًا وتأكد من أنه متاح في الـ PATH
RUN npm install -g pm2 && \
    ln -sf /usr/local/bin/pm2 /usr/bin/pm2 && \
    ln -sf /usr/local/bin/pm2-runtime /usr/bin/pm2-runtime

EXPOSE 10000

CMD ["pm2-runtime", "server.js"]
