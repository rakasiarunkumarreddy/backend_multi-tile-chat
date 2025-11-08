// openaiClient.js
import dotenv from "dotenv";
dotenv.config(); // ✅ This loads your .env file before anything else

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // ✅ Now this will be available
});

export default openai;
