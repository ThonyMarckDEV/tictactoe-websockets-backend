# Usamos Node.js versión 23.9.0 en su variante alpine para un contenedor liviano
FROM node:23.9.0-alpine

# Establece el directorio de trabajo en el contenedor
WORKDIR /app

# Copia los archivos de dependencias
COPY package*.json ./

# Instala las dependencias
RUN npm install

# Copia el resto del código de la aplicación
COPY . .

# Expone el puerto en el que se ejecuta el servidor (ajusta si es necesario)
EXPOSE 5000

# Ejecuta el servidor usando node server.js
CMD ["node", "server.js"]
