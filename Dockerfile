# Deployment image.
#
# No build step: the server runs TypeScript directly through tsx, and the whole
# knowledge index is committed, so there is nothing to compile and nothing to
# extract at boot. That is also why this is a single stage -- there are no build
# artifacts to copy out of anywhere.
FROM node:22-slim

WORKDIR /app

# Dependencies first, so a change to the app does not reinstall them.
COPY package.json package-lock.json ./
# `npm ci` and not `npm install`: the lockfile is committed and a deploy should
# resolve to exactly what was tested. tsx lives in dependencies, not
# devDependencies, because `npm start` executes through it -- installing with
# --omit=dev and then failing to boot is the trap this avoids.
RUN npm ci --omit=dev

COPY . .

# Fly sets PORT; the server reads it and falls back to 8788 locally.
ENV PORT=8080
EXPOSE 8080

# Deliberately no ANTHROPIC_API_KEY. A public URL wired to a personal key is an
# open tap on that account. Everything that does not call the model serves
# without one, and asking the agent a question prompts the viewer for theirs.
CMD ["npm", "start"]
