import supabase from "../supabaseClient.js";

export async function addTokens(userId, tokens) {
  const { data: existing } = await supabase
    .from("token_usage")
    .select("*")
    .eq("user_id", userId)
    .limit(1);

  if (existing && existing.length > 0) {
    const total = existing[0].total_tokens + tokens;
    await supabase
      .from("token_usage")
      .update({ total_tokens: total, updated_at: new Date().toISOString() })
      .eq("id", existing[0].id);
    return total;
  } else {
    await supabase.from("token_usage").insert([{ user_id: userId, total_tokens: tokens }]);
    return tokens;
  }
}

export async function getTokens(userId) {
  const { data } = await supabase.from("token_usage").select("*").eq("user_id", userId).limit(1);
  return data && data.length ? data[0].total_tokens : 0;
}
