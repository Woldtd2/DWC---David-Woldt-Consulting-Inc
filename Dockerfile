FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
ENV DATA_SOURCE=live
EXPOSE 8787
CMD ["node", "server.js"]
