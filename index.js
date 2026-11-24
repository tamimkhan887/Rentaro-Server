import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';
import dns from 'node:dns';

dns.setServers(['8.8.8.8', '1.1.1.1']);
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

app.post("/equipments", async (req, res) => {
    const result = await equipmentCollection.insertOne(req.body)
    res.send(result)
})

// GET /equipments with Backend Search, Filter, Sort and Limit
app.get("/equipments", async (req, res) => {
    try {
        const query = {}

        // Owner Email filter
        if (req.query.ownerEmail) {
            query.ownerEmail = req.query.ownerEmail
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

// POST create a booking
app.post("/bookings", async (req, res) => {
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
        } = req.body;

        if (!equipmentId || !userEmail || !startDate || !endDate || !contactNumber || !deliveryAddress) {
            return res.status(400).send({ error: "Missing required booking fields" });
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
            status: "Pending", // Default booking status
            createdAt: new Date().toISOString(),
        };

        const result = await bookingsCollection.insertOne(newBooking);
        res.send({ success: true, insertedId: result.insertedId });
    } catch (err) {
        console.error("Error in POST /bookings:", err);
        res.status(500).send({ error: "Failed to create booking" });
    }
});

// GET bookings
app.get("/bookings", async (req, res) => {
    try {
        const query = {};
        if (req.query.userEmail) {
            query.userEmail = req.query.userEmail;
        }
        if (req.query.ownerEmail) {
            query.ownerEmail = req.query.ownerEmail;
        }
        const result = await bookingsCollection.find(query).sort({ createdAt: -1 }).toArray();
        res.send(result);
    } catch (err) {
        console.error("Error in GET /bookings:", err);
        res.status(500).send({ error: "Failed to fetch bookings" });
    }
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});
