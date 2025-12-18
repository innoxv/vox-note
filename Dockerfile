FROM node:18-alpine

# Install FFmpeg with minimal dependencies
RUN apk add --no-cache ffmpeg

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies with memory limit
RUN npm ci --only=production --max-old-space-size=1024

# Copy app source
COPY . .

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

# Expose port
EXPOSE 3000

# Start with memory limit
CMD ["node", "--max-old-space-size=460", "bot.js"]