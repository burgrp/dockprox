FROM node:16-alpine

WORKDIR /app
COPY package.json package-lock.json config.json ./
COPY src ./src
RUN ln -s /usr/local/bin /usr/local/sbin
RUN npm install

EXPOSE 80/tcp

CMD node --inspect=0.0.0.0:9229 src/main.js