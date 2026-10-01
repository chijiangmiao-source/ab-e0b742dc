FROM node:20-alpine

WORKDIR /app

# No third-party runtime dependencies; copy sources and build the page.
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY test ./test

RUN node scripts/build.js

ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "scripts/server.js"]
