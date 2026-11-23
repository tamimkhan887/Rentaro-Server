import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
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

app.post("/equipments", async (req, res) => {
    const result = await equipmentCollection.insertOne(req.body)
    res.send(result)
})

app.get("/equipments", async (req, res) => {
    if (req.query.ownerEmail) {
        const result = await equipmentCollection.find({ ownerEmail: req.query.ownerEmail }).toArray()
        res.send(result)
    }
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});