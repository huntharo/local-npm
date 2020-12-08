FROM node:8

RUN adduser -q --disabled-password localnpm
USER localnpm
WORKDIR /home/localnpm

COPY package.json .
RUN npm install

# COPY sets owner to root, have to chown them
# No, Docker does not have a feature to set user on COPY
COPY . .
USER root
# RUN chown -R localnpm:localnpm *
# RUN shopt -s extglob; chown -R localnpm:localnpm -- !(node_modules)
RUN find . -maxdepth 2 ! -name node_modules -exec chown localnpm:localnpm {} \;
USER localnpm

RUN npm run lint
RUN npm run build

CMD [ "node", "./bin/index.js", "--log-level", "debug" ]
