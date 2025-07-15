# Imagen base ligera con Node.js
FROM node:23.9.0-alpine

# Establecer directorio de trabajo
WORKDIR /app

# Copiar dependencias
COPY package*.json ./

# Instalar dependencias
RUN npm install

# Copiar el resto del código
COPY . .

# Exponer los puertos necesarios
EXPOSE 8008
EXPOSE 8009

# Ejecutar la app
CMD ["node", "server.js"]
