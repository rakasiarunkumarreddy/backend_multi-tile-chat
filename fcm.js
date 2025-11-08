import axios from "axios";

const sendPushNotification = async (token, title, body) => {
  const FCM_URL = "https://fcm.googleapis.com/fcm/send";
  const headers = {
    Authorization: `key=${process.env.FIREBASE_SERVER_KEY}`,
    "Content-Type": "application/json",
  };

  const payload = {
    to: token,
    notification: {
      title,
      body,
    },
  };

  await axios.post(FCM_URL, payload, { headers });
};

export default sendPushNotification;
