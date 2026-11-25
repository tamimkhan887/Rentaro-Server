import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';
import dns from 'node:dns';
import jwt from 'jsonwebtoken';

try {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch {
    // Fallback to system default DNS
}
const app = express();
const port = process.env.PORT || 5000;

app.use(cors())
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Rentora is running');
});

const client = new MongoClient(process.env.MONGODB_URL);
export async function connectToMongoDB() {
    try {
        await client.connect();
        console.log("You successfully connected to MongoDB!");
        return client;
    } catch (err) {
        console.dir(err);
        throw err;
    }
}

const connectedClient = await connectToMongoDB();
const rentoraDb = connectedClient.db("rentora")
const equipmentCollection = rentoraDb.collection("equipments")
const favoritesCollection = rentoraDb.collection("favorites")
const bookingsCollection = rentoraDb.collection("bookings")
const userCollection = rentoraDb.collection("user")
const sessionCollection = rentoraDb.collection("session")

// ==========================================
// JWT AUTHENTICATION ENDPOINTS
// ==========================================

// POST /jwt - Generate JWT Access Token upon successful login
app.post("/jwt", async (req, res) => {
    try {
        const user = req.body;
        if (!user || !user.email) {
            return res.status(400).send({ error: "User email is required" });
        }

        const normalizedEmail = user.email.trim().toLowerCase();

        // Retrieve verified user role and ID from database if available
        const dbUser = await userCollection.findOne({
            email: { $regex: new RegExp(`^${normalizedEmail}$`, "i") },
        });

        const tokenPayload = {
            email: normalizedEmail,
            name: dbUser?.name || user.name || "",
            role: dbUser?.role || user.role || "customer",
            userId: dbUser?._id?.toString() || user.userId || "",
        };

        const secret = process.env.ACCESS_TOKEN_SECRET || "rentora_jwt_access_token_secret_key_2026_super_secure_ph14";
        const token = jwt.sign(tokenPayload, secret, { expiresIn: "7d" });

        res.send({ success: true, token, user: tokenPayload });
    } catch (err) {
        console.error("Error generating JWT access token:", err);
        res.status(500).send({ error: "Failed to generate access token" });
    }
});

// POST /logout - Clear session
app.post("/logout", (req, res) => {
    res.send({ success: true, message: "Logged out successfully" });
});

// ==========================================
// CUSTOM ROLE-BASED ACCESS CONTROL (RBAC) MIDDLEWARES
// ==========================================

// 1. verifyToken: Verifies JWT token or session and attaches req.user
const verifyToken = async (req, res, next) => {
    // For public equipment listing without ownerEmail filter, allow access
    if (req.path === "/equipments" && req.method === "GET" && !req.query.ownerEmail) {
        const authHeader = req.headers?.authorization;
        if (authHeader) {
            const token = authHeader.split(" ")[1];
            if (token) {
                const secret = process.env.ACCESS_TOKEN_SECRET || "rentora_jwt_access_token_secret_key_2026_super_secure_ph14";
                try {
                    const decoded = jwt.verify(token, secret);
                    if (decoded) req.user = decoded;
                } catch {
                    try {
                        const session = await sessionCollection.findOne({ token });
                        if (session) {
                            const userId = session.userId;
                            const userQuery = ObjectId.isValid(userId)
                                ? { $or: [{ _id: new ObjectId(userId) }, { _id: userId }, { id: userId }] }
                                : { $or: [{ _id: userId }, { id: userId }] };
                            const user = await userCollection.findOne(userQuery);
                            if (user) req.user = user;
                        }
                    } catch {}
                }
            }
        }
        return next();
    }

    const authHeader = req.headers?.authorization;
    if (!authHeader) {
        return res.status(401).send({ message: "Unauthorized access: Token missing" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
        return res.status(401).send({ message: "Unauthorized access: Invalid token format" });
    }

    const secret = process.env.ACCESS_TOKEN_SECRET || "rentora_jwt_access_token_secret_key_2026_super_secure_ph14";

    // 1. Try JWT verification first
    try {
        const decoded = jwt.verify(token, secret);
        if (decoded) {
            // Retrieve fresh role from DB if available
            const dbUser = await userCollection.findOne({
                email: { $regex: new RegExp(`^${(decoded.email || "").trim()}$`, "i") }
            });
            req.user = dbUser ? { ...decoded, role: dbUser.role || decoded.role } : decoded;
            return next();
        }
    } catch {
        // Token is not a JWT or invalid, try session lookup
    }

    // 2. Fallback to Better Auth session lookup
    try {
        const session = await sessionCollection.findOne({ token });
        if (!session) {
            return res.status(401).send({ message: "Unauthorized access: Invalid or expired session" });
        }
        const userId = session.userId;
        const userQuery = ObjectId.isValid(userId)
            ? { $or: [{ _id: new ObjectId(userId) }, { _id: userId }, { id: userId }] }
            : { $or: [{ _id: userId }, { id: userId }] };
        const user = await userCollection.findOne(userQuery);
        if (!user) {
            return res.status(401).send({ message: "Unauthorized access: User not found" });
        }

        req.user = {
            email: user.email,
            name: user.name,
            role: user.role || "customer",
            userId: user._id?.toString(),
        };
        return next();
    } catch (err) {
        console.error("verifyToken error:", err);
        return res.status(401).send({ message: "Unauthorized access" });
    }
};

// 2. verifyRenter: Restricts access to Renters / Customers (and Admin)
const verifyRenter = async (req, res, next) => {
    const role = (req.user?.role || "").toLowerCase();
    if (role === "customer" || role === "renter" || role === "admin") {
        return next();
    }
    return res.status(403).send({ message: "Forbidden access: Renter permission required" });
};

// 3. verifyOwner: Restricts access to Equipment Owners (and Admin)
const verifyOwner = async (req, res, next) => {
    const role = (req.user?.role || "").toLowerCase();
    if (role === "owner" || role === "admin") {
        return next();
    }
    return res.status(403).send({ message: "Forbidden access: Equipment Owner permission required" });
};

// 4. verifyAdmin: Restricts access strictly to Admins
const verifyAdmin = async (req, res, next) => {
    const role = (req.user?.role || "").toLowerCase();
    if (role === "admin") {
        return next();
    }
    return res.status(403).send({ message: "Forbidden access: Admin permission required" });
};

// ==========================================
// EQUIPMENT ENDPOINTS (Protected with Role Access)
// ==========================================

// POST /equipments - Only Equipment Owners (or Admin) can list machinery
app.post("/equipments", verifyToken, verifyOwner, async (req, res) => {
    const result = await equipmentCollection.insertOne(req.body)
    res.send(result)
})

app.get("/equipments", verifyToken, async (req, res) => {
    try {
        const query = {}

        // Owner Email filter
        if (req.query.ownerEmail) {
            const queryEmail = req.query.ownerEmail.trim().toLowerCase();
            const userEmail = (req.user?.email || "").trim().toLowerCase();
            if (userEmail !== queryEmail && req.user?.role !== "admin") {
                res.status(403).send({ message: "Forbidden" });
                return;
            }
            query.ownerEmail = { $regex: new RegExp(`^${queryEmail}$`, "i") };
        }

        // Status filter (e.g. Approved)
        if (req.query.status && req.query.status !== "all") {
            query.status = { $regex: new RegExp(`^${req.query.status}$`, "i") }
        }

        // Search: Equipment Name or Location
        const searchConditions = []
        if (req.query.search && req.query.search.trim()) {
            const searchTerm = req.query.search.trim()
            const searchRegex = { $regex: searchTerm, $options: "i" }
            searchConditions.push(
                { name: searchRegex },
                { location: searchRegex },
                { brand: searchRegex },
                { model: searchRegex }
            )
        }

        if (req.query.name && req.query.name.trim()) {
            query.name = { $regex: req.query.name.trim(), $options: "i" }
        }

        if (req.query.location && req.query.location.trim()) {
            query.location = { $regex: req.query.location.trim(), $options: "i" }
        }

        if (searchConditions.length > 0) {
            query.$or = searchConditions
        }

        // Filter: Category
        if (req.query.category && req.query.category !== "All" && req.query.category !== "") {
            query.category = req.query.category
        }

        // Filter: Rental Type (Daily, Weekly, Monthly)
        if (req.query.rentalType && req.query.rentalType !== "All" && req.query.rentalType !== "") {
            query.rentalType = req.query.rentalType
        }

        // Filter: Price Range (minPrice, maxPrice)
        const minP = req.query.minPrice !== undefined && req.query.minPrice !== "" ? Number(req.query.minPrice) : null
        const maxP = req.query.maxPrice !== undefined && req.query.maxPrice !== "" ? Number(req.query.maxPrice) : null
        if (minP !== null || maxP !== null) {
            query.price = {}
            if (minP !== null && !isNaN(minP)) {
                query.price.$gte = minP
            }
            if (maxP !== null && !isNaN(maxP)) {
                query.price.$lte = maxP
            }
            if (Object.keys(query.price).length === 0) {
                delete query.price
            }
        }

        // Filter: Availability Status
        if (req.query.availability && req.query.availability !== "all" && req.query.availability !== "") {
            const avail = req.query.availability.toLowerCase()
            if (avail === "available" || avail === "in_stock" || avail === "in-stock") {
                query.quantity = { $gt: 0 }
            } else if (avail === "unavailable" || avail === "out_of_stock" || avail === "out-of-stock") {
                query.quantity = { $lte: 0 }
            }
        }

        // Sorting: Price Low to High, Price High to Low, Recently Added
        let sortOption = { createdAt: -1, _id: -1 }
        const sort = (req.query.sort || req.query.sortBy || "").toLowerCase()
        if (
            sort === "price-asc" ||
            sort === "price_asc" ||
            sort === "price_low_high" ||
            sort === "low-to-high" ||
            sort === "lowtohigh"
        ) {
            sortOption = { price: 1 }
        } else if (
            sort === "price-desc" ||
            sort === "price_desc" ||
            sort === "price_high_low" ||
            sort === "high-to-low" ||
            sort === "hightolow"
        ) {
            sortOption = { price: -1 }
        } else if (
            sort === "recently-added" ||
            sort === "recently_added" ||
            sort === "newest" ||
            sort === "recent"
        ) {
            sortOption = { createdAt: -1, _id: -1 }
        }

        // If limit is provided (e.g. for featured section using MongoDB $limit)
        if (req.query.limit) {
            const limitNum = parseInt(req.query.limit, 10)
            const pipeline = []
            if (Object.keys(query).length > 0) {
                pipeline.push({ $match: query })
            }
            pipeline.push({ $sort: sortOption })
            pipeline.push({ $limit: limitNum })
            const result = await equipmentCollection.aggregate(pipeline).toArray()
            return res.send(result)
        }


        const result = await equipmentCollection.find(query).sort(sortOption).toArray()
        res.send(result)
    } catch (err) {
        console.error("Error in GET /equipments:", err)
        res.status(500).send({ error: "Failed to fetch equipments" })
    }
})

// GET single equipment by ID
app.get("/equipments/:id", async (req, res) => {
    try {
        const id = req.params.id;
        let query = {};
        if (ObjectId.isValid(id)) {
            query = { _id: new ObjectId(id) };
        } else {
            query = { _id: id };
        }
        console.log(req.query)
        const result = await equipmentCollection.findOne(query);
        if (!result) {
            return res.status(404).send({ error: "Equipment not found" });
        }
        res.send(result);
    } catch (err) {
        console.error("Error in GET /equipments/:id:", err);
        res.status(500).send({ error: "Failed to fetch equipment" });
    }
});

// PUT / PATCH update equipment by ID (Equipment Owner or Admin)
app.put("/equipments/:id", verifyToken, verifyOwner, async (req, res) => {
    try {
        const id = req.params.id;
        let query = {};
        if (ObjectId.isValid(id)) {
            query = { _id: new ObjectId(id) };
        } else {
            query = { _id: id };
        }

        const updateData = { ...req.body };
        delete updateData._id;
        delete updateData.id;
        updateData.updatedAt = new Date().toISOString();

        if (updateData.price !== undefined) {
            updateData.price = Number(updateData.price);
        }
        if (updateData.quantity !== undefined) {
            updateData.quantity = Number(updateData.quantity);
        }

        const result = await equipmentCollection.updateOne(query, {
            $set: updateData,
        });

        res.send({ success: true, modifiedCount: result.modifiedCount });
    } catch (err) {
        console.error("Error in PUT /equipments/:id:", err);
        res.status(500).send({ error: "Failed to update equipment" });
    }
});

// PATCH update equipment (Equipment Owner or Admin)
app.patch("/equipments/:id", verifyToken, verifyOwner, async (req, res) => {
    try {
        const id = req.params.id;
        let query = {};
        if (ObjectId.isValid(id)) {
            query = { _id: new ObjectId(id) };
        } else {
            query = { _id: id };
        }

        const updateData = { ...req.body };
        delete updateData._id;
        delete updateData.id;
        updateData.updatedAt = new Date().toISOString();

        if (updateData.price !== undefined) {
            updateData.price = Number(updateData.price);
        }
        if (updateData.quantity !== undefined) {
            updateData.quantity = Number(updateData.quantity);
        }

        const result = await equipmentCollection.updateOne(query, {
            $set: updateData,
        });

        res.send({ success: true, modifiedCount: result.modifiedCount });
    } catch (err) {
        console.error("Error in PATCH /equipments/:id:", err);
        res.status(500).send({ error: "Failed to update equipment" });
    }
});

// DELETE equipment by ID (Equipment Owner or Admin)
app.delete("/equipments/:id", verifyToken, verifyOwner, async (req, res) => {
    try {
        const id = req.params.id;
        let query = {};
        if (ObjectId.isValid(id)) {
            query = { _id: new ObjectId(id) };
        } else {
            query = { _id: id };
        }

        const result = await equipmentCollection.deleteOne(query);
        res.send({ success: true, deletedCount: result.deletedCount });
    } catch (err) {
        console.error("Error in DELETE /equipments/:id:", err);
        res.status(500).send({ error: "Failed to delete equipment" });
    }
});

// ==========================================
// FAVORITES ENDPOINTS
// ==========================================

// Check if item is already in favorites
app.get("/favorites/check", async (req, res) => {
    try {
        const { userEmail, equipmentId } = req.query;
        if (!userEmail || !equipmentId) {
            return res.status(400).send({ error: "userEmail and equipmentId are required" });
        }
        const existing = await favoritesCollection.findOne({ userEmail, equipmentId });
        res.send({ isFavorite: !!existing, favoriteId: existing ? existing._id : null });
    } catch (err) {
        console.error("Error checking favorite:", err);
        res.status(500).send({ error: "Failed to check favorite" });
    }
});

// GET all favorites for a user
app.get("/favorites", async (req, res) => {
    try {
        const query = {};
        if (req.query.userEmail) {
            query.userEmail = req.query.userEmail;
        }
        const result = await favoritesCollection.find(query).sort({ createdAt: -1 }).toArray();
        res.send(result);
    } catch (err) {
        console.error("Error in GET /favorites:", err);
        res.status(500).send({ error: "Failed to fetch favorites" });
    }
});

// POST add to favorites
app.post("/favorites", async (req, res) => {
    try {
        const { userEmail, equipmentId, equipment } = req.body;
        if (!userEmail || !equipmentId) {
            return res.status(400).send({ error: "userEmail and equipmentId are required" });
        }

        // Check if already in favorites
        const existing = await favoritesCollection.findOne({ userEmail, equipmentId });
        if (existing) {
            return res.send({ exists: true, message: "Item is already in favorites", insertedId: existing._id });
        }

        const newFavorite = {
            userEmail,
            equipmentId,
            equipment: equipment || null,
            createdAt: new Date().toISOString(),
        };

        const result = await favoritesCollection.insertOne(newFavorite);
        res.send({ success: true, insertedId: result.insertedId });
    } catch (err) {
        console.error("Error in POST /favorites:", err);
        res.status(500).send({ error: "Failed to save favorite" });
    }
});

// DELETE remove from favorites by ID
app.delete("/favorites/:id", async (req, res) => {
    try {
        const id = req.params.id;
        let query = {};
        if (ObjectId.isValid(id)) {
            query = { _id: new ObjectId(id) };
        } else {
            query = { _id: id };
        }
        const result = await favoritesCollection.deleteOne(query);
        res.send({ success: true, deletedCount: result.deletedCount });
    } catch (err) {
        console.error("Error in DELETE /favorites/:id:", err);
        res.status(500).send({ error: "Failed to delete favorite" });
    }
});

// DELETE remove from favorites by query { userEmail, equipmentId }
app.delete("/favorites", async (req, res) => {
    try {
        const { userEmail, equipmentId } = req.query;
        if (!userEmail || !equipmentId) {
            return res.status(400).send({ error: "userEmail and equipmentId are required" });
        }
        const result = await favoritesCollection.deleteOne({ userEmail, equipmentId });
        res.send({ success: true, deletedCount: result.deletedCount });
    } catch (err) {
        console.error("Error in DELETE /favorites:", err);
        res.status(500).send({ error: "Failed to delete favorite" });
    }
});

// ==========================================
// BOOKINGS / RENTALS ENDPOINTS
// ==========================================

// POST create a booking (Renter / Customer or Admin)
app.post("/bookings", verifyToken, verifyRenter, async (req, res) => {
    try {
        const {
            equipmentId,
            equipmentName,
            equipmentImage,
            rentalPrice,
            rentalType,
            ownerEmail,
            ownerName,
            userEmail,
            userName,
            startDate,
            endDate,
            quantity,
            contactNumber,
            deliveryAddress,
            additionalNotes,
            totalPrice,
            status,
            paymentStatus,
            transactionId,
            stripeSessionId,
            paidAt,
        } = req.body;

        if (!equipmentId || !userEmail || !startDate || !endDate || !contactNumber || !deliveryAddress) {
            return res.status(400).send({ error: "Missing required booking fields" });
        }

        // Idempotency: check if booking already exists for this stripeSessionId
        if (stripeSessionId) {
            const existing = await bookingsCollection.findOne({ stripeSessionId });
            if (existing) {
                return res.send({ success: true, insertedId: existing._id, existing: true, booking: existing });
            }
        }

        const newBooking = {
            equipmentId,
            equipmentName: equipmentName || "",
            equipmentImage: equipmentImage || "",
            rentalPrice: Number(rentalPrice) || 0,
            rentalType: rentalType || "Daily",
            ownerEmail: ownerEmail || "",
            ownerName: ownerName || "",
            userEmail,
            userName: userName || "Customer",
            startDate,
            endDate,
            quantity: Number(quantity) || 1,
            contactNumber,
            deliveryAddress,
            additionalNotes: additionalNotes || "",
            totalPrice: Number(totalPrice) || Number(rentalPrice) || 0,
            status: status || "Confirmed",
            paymentStatus: paymentStatus || "Paid",
            transactionId: transactionId || "",
            stripeSessionId: stripeSessionId || "",
            paidAt: paidAt || new Date().toISOString(),
            createdAt: new Date().toISOString(),
        };

        const result = await bookingsCollection.insertOne(newBooking);

        // Atomically reduce available equipment stock in equipmentCollection
        try {
            const bookedQty = Number(quantity) || 1;
            let eqQuery = {};
            if (ObjectId.isValid(equipmentId)) {
                eqQuery = { $or: [{ _id: new ObjectId(equipmentId) }, { _id: equipmentId }, { id: equipmentId }] };
            } else {
                eqQuery = { $or: [{ _id: equipmentId }, { id: equipmentId }] };
            }

            const currentEquipment = await equipmentCollection.findOne(eqQuery);
            if (currentEquipment) {
                const currentQty = Number(currentEquipment.quantity) || 0;
                const newQty = Math.max(0, currentQty - bookedQty);
                await equipmentCollection.updateOne(eqQuery, {
                    $set: {
                        quantity: newQty,
                        updatedAt: new Date().toISOString(),
                    },
                });
            }
        } catch (stockErr) {
            console.error("Error reducing equipment stock:", stockErr);
        }

        res.send({ success: true, insertedId: result.insertedId, booking: newBooking });
    } catch (err) {
        console.error("Error in POST /bookings:", err);
        res.status(500).send({ error: "Failed to create booking" });
    }
});

// PATCH update booking status (restore stock if cancelled)
// PATCH update booking status (Equipment Owner or Admin)
app.patch("/bookings/:id/status", verifyToken, verifyOwner, async (req, res) => {
    try {
        const id = req.params.id;
        const { status } = req.body;
        if (!status) {
            return res.status(400).send({ error: "status is required" });
        }

        let query = {};
        if (ObjectId.isValid(id)) {
            query = { $or: [{ _id: new ObjectId(id) }, { _id: id }] };
        } else {
            query = { _id: id };
        }

        const existingBooking = await bookingsCollection.findOne(query);
        if (!existingBooking) {
            return res.status(404).send({ error: "Booking not found" });
        }

        // If booking is being cancelled, restore the reserved stock
        if (status === "Cancelled" && existingBooking.status !== "Cancelled") {
            try {
                let eqQuery = {};
                const eqId = existingBooking.equipmentId;
                if (ObjectId.isValid(eqId)) {
                    eqQuery = { $or: [{ _id: new ObjectId(eqId) }, { _id: eqId }, { id: eqId }] };
                } else {
                    eqQuery = { $or: [{ _id: eqId }, { id: eqId }] };
                }
                const eq = await equipmentCollection.findOne(eqQuery);
                if (eq) {
                    const currentQty = Number(eq.quantity) || 0;
                    const restoredQty = currentQty + (Number(existingBooking.quantity) || 1);
                    await equipmentCollection.updateOne(eqQuery, {
                        $set: {
                            quantity: restoredQty,
                            updatedAt: new Date().toISOString(),
                        },
                    });
                }
            } catch (restoreErr) {
                console.error("Error restoring stock on cancel:", restoreErr);
            }
        }

        const result = await bookingsCollection.updateOne(query, {
            $set: {
                status,
                updatedAt: new Date().toISOString(),
            },
        });

        res.send({ success: true, modifiedCount: result.modifiedCount, status });
    } catch (err) {
        console.error("Error in PATCH /bookings/:id/status:", err);
        res.status(500).send({ error: "Failed to update booking status" });
    }
});

// GET bookings (Protected: Renters can view own bookings, Owners can view own rentals, Admins can view all)
app.get("/bookings", verifyToken, async (req, res) => {
    try {
        const query = {};
        const userRole = (req.user?.role || "").toLowerCase();
        const userEmail = (req.user?.email || "").toLowerCase();

        if (req.query.userEmail) {
            const qUser = req.query.userEmail.trim().toLowerCase();
            if (userEmail !== qUser && userRole !== "admin") {
                return res.status(403).send({ message: "Forbidden: Cannot view other renter's bookings" });
            }
            query.userEmail = { $regex: new RegExp(`^${qUser}$`, "i") };
        }

        if (req.query.ownerEmail) {
            const qOwner = req.query.ownerEmail.trim().toLowerCase();
            if (userEmail !== qOwner && userRole !== "admin") {
                return res.status(403).send({ message: "Forbidden: Cannot view other owner's rentals" });
            }
            query.ownerEmail = { $regex: new RegExp(`^${qOwner}$`, "i") };
        }

        // If neither userEmail nor ownerEmail is queried, Admin permission is required to view all bookings
        if (!req.query.userEmail && !req.query.ownerEmail && userRole !== "admin") {
            return res.status(403).send({ message: "Forbidden: Admin permission required to view all bookings" });
        }

        const result = await bookingsCollection.find(query).sort({ createdAt: -1 }).toArray();
        res.send(result);
    } catch (err) {
        console.error("Error in GET /bookings:", err);
        res.status(500).send({ error: "Failed to fetch bookings" });
    }
});

// ==========================================
// USER MANAGEMENT ENDPOINTS
// ==========================================

// GET all users (strictly Admin only)
app.get(["/users", "/user"], verifyToken, verifyAdmin, async (req, res) => {
    try {
        const query = {};

        // Role filter
        if (req.query.role && req.query.role !== "all" && req.query.role !== "All") {
            query.role = { $regex: new RegExp(`^${req.query.role}$`, "i") };
        }

        // Search by name or email
        if (req.query.search && req.query.search.trim()) {
            const searchTerm = req.query.search.trim();
            const searchRegex = { $regex: searchTerm, $options: "i" };
            query.$or = [{ name: searchRegex }, { email: searchRegex }];
        }

        const users = await userCollection.find(query).sort({ createdAt: -1 }).toArray();
        res.send(users);
    } catch (err) {
        console.error("Error in GET /users:", err);
        res.status(500).send({ error: "Failed to fetch users" });
    }
});

// GET single user by ID
app.get("/users/:id", verifyToken, async (req, res) => {
    try {
        const id = req.params.id;
        let query = {};
        if (ObjectId.isValid(id)) {
            query = { $or: [{ _id: new ObjectId(id) }, { _id: id }, { id: id }] };
        } else {
            query = { $or: [{ _id: id }, { id: id }] };
        }

        const user = await userCollection.findOne(query);
        if (!user) {
            return res.status(404).send({ error: "User not found" });
        }
        res.send(user);
    } catch (err) {
        console.error("Error in GET /users/:id:", err);
        res.status(500).send({ error: "Failed to fetch user" });
    }
});

// PATCH / PUT update user role (strictly Admin only)
app.patch("/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        const { role } = req.body;

        if (!role) {
            return res.status(400).send({ error: "Role is required" });
        }

        let query = {};
        if (ObjectId.isValid(id)) {
            query = { $or: [{ _id: new ObjectId(id) }, { _id: id }, { id: id }] };
        } else {
            query = { $or: [{ _id: id }, { id: id }] };
        }

        const result = await userCollection.updateOne(query, {
            $set: {
                role: role,
                updatedAt: new Date().toISOString(),
            },
        });

        res.send({ success: true, modifiedCount: result.modifiedCount, role });
    } catch (err) {
        console.error("Error in PATCH /users/:id/role:", err);
        res.status(500).send({ error: "Failed to update user role" });
    }
});

// PATCH / PUT update user (User themselves or Admin)
app.patch("/users/:id", verifyToken, async (req, res) => {
    try {
        const id = req.params.id;
        let query = {};
        if (ObjectId.isValid(id)) {
            query = { $or: [{ _id: new ObjectId(id) }, { _id: id }, { id: id }] };
        } else {
            query = { $or: [{ _id: id }, { id: id }] };
        }

        const updateData = { ...req.body };
        delete updateData._id;
        delete updateData.id;
        updateData.updatedAt = new Date().toISOString();

        const result = await userCollection.updateOne(query, {
            $set: updateData,
        });

        res.send({ success: true, modifiedCount: result.modifiedCount });
    } catch (err) {
        console.error("Error in PATCH /users/:id:", err);
        res.status(500).send({ error: "Failed to update user" });
    }
});

// DELETE user by ID (strictly Admin only)
app.delete("/users/:id", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        let query = {};
        if (ObjectId.isValid(id)) {
            query = { $or: [{ _id: new ObjectId(id) }, { _id: id }, { id: id }] };
        } else {
            query = { $or: [{ _id: id }, { id: id }] };
        }

        const result = await userCollection.deleteOne(query);
        res.send({ success: true, deletedCount: result.deletedCount });
    } catch (err) {
        console.error("Error in DELETE /users/:id:", err);
        res.status(500).send({ error: "Failed to delete user" });
    }
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});

export default app;
