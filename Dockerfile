FROM node:20-slim
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .
RUN mkdir -p wa-session
EXPOSE 3000
CMD ["node", "server.js"]
