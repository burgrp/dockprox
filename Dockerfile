FROM node:12.16.3-alpine

WORKDIR /app
COPY package.json package-lock.json config.json ./
COPY src ./src
RUN npm install

EXPOSE 80/tcp

CMD node --inspect=0.0.0.0:9229 src/main.js