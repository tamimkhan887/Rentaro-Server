# Rentora Backend Server API

RESTful API backend service for the **Rentora** Heavy Industrial Equipment & Machinery Rental Platform.

## 🚀 Technologies & Dependencies
- **Express.js (v5.3.0):** Core REST API router and controllers.
- **MongoDB Node Driver (v7.9.1):** MongoDB Atlas connection and aggregation pipelines.
- **jsonwebtoken (v9.0.3):** Cryptographic signing and validation of user access tokens.
- **cors:** Cross-Origin Resource Sharing configuration.
- **dotenv:** Environment variables management.

## 🔐 Custom RBAC Middlewares
- `verifyToken`: Validates incoming JWT access tokens with fallback to Better-Auth session tokens.
- `verifyRenter`: Restricts routes to Renters / Customers and Admins.
- `verifyOwner`: Restricts routes to Equipment Owners and Admins.
- `verifyAdmin`: Enforces strict Admin-only access.

## ⚙️ Environment Variables
```env
PORT=5000
MONGODB_URL=mongodb+srv://...
ACCESS_TOKEN_SECRET=your_jwt_secret_key
```

## 🏃 Running the Server
```bash
npm install
npm start
# or with nodemon:
npx nodemon index.js
```
