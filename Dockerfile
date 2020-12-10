FROM node:10 as build

WORKDIR /home/localnpm

COPY package.json .npmrc* ./
RUN npm install

# COPY sets owner to root, have to chown them
# No, Docker does not have a feature to set user on COPY
COPY . .

RUN npm run lint
RUN npm run build

RUN npm ci --only=production

#
# Runtime image
#
FROM node:10-slim as runtime

RUN adduser -q --disabled-password localnpm
USER localnpm
WORKDIR /home/localnpm

COPY --from=build /home/localnpm .

USER root
# chown everything except node_modules (installed above)
RUN find . -maxdepth 2 ! -name node_modules -exec chown localnpm:localnpm {} \;
RUN mkdir -p /var/lib/pouchdb/data
RUN chown localnpm:localnpm /var/lib/pouchdb/data
USER localnpm

CMD [ "node", "./bin/index.js", "--log-level", "debug" ]
