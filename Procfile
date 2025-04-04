FROM node:18-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npm install -g pm2

EXPOSE 10000

CMD ["pm2-runtime", "server.js"]
