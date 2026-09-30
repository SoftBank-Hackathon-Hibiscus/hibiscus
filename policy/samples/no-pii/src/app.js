import express from "express";
import { db } from "./db.js";

const app = express();
app.use(express.json());

app.get("/todos", (req, res) => {
  res.json(db.prepare("SELECT id, title, done FROM todos ORDER BY id").all());
});

app.post("/todos", (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: "title required" });
  const info = db.prepare("INSERT INTO todos (title) VALUES (?)").run(title);
  res.status(201).json({ id: info.lastInsertRowid, title, done: 0 });
});

app.patch("/todos/:id", (req, res) => {
  db.prepare("UPDATE todos SET done = ? WHERE id = ?").run(req.body.done ? 1 : 0, req.params.id);
  res.status(204).end();
});

app.listen(3000);
