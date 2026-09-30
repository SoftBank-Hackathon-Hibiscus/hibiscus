import { db } from "../db.js";

export function signup(req, res) {
  const { name, contact } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  if (!/^01[016789]-?\d{3,4}-?\d{4}$/.test(contact)) {
    return res.status(400).json({ error: "invalid phone" });
  }
  db.run("INSERT INTO users (name, contact) VALUES (?, ?)", [name, contact]);
  res.redirect("/todos");
}
