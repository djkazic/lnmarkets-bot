FROM node:18-alpine

WORKDIR /app

COPY . ./

RUN npm install --only=production

# Run the web service on container startup.
CMD [ "node", "main.mjs" ]
