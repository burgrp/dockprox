FROM node:10-alpine

WORKDIR /app
COPY package.json package-lock.json config.json ./
COPY src ./src
RUN npm install

EXPOSE 80/tcp

CMD node src/main.js