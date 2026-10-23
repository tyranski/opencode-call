FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm

USER root

# Override this build argument to install a specific OpenCode release.
ARG OPENCODE_VERSION=latest
RUN npm install --global "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force \
    && opencode --version

# Seed the named volumes with directories owned by the development user.
RUN mkdir -p /home/node/.config/opencode /home/node/.local/share/opencode \
    && chown -R node:node /home/node/.config /home/node/.local

USER node
