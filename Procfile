FROM node:18.20.4-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 10000

CMD ["node", "node_modules/pm2/bin/pm2-runtime", "server.js"]
