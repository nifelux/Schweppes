/**
 * /api/admin.js — All admin actions
 *
 * GET  ?action=deposits&status=&admin_id=
 * GET  ?action=withdrawals&status=
 * GET  ?action=users
 * GET  ?action=user-team&target_user_id=
 * GET  ?action=products
 * GET  ?action=messages
 * GET  ?action=gift-codes
 * GET  ?action=stats
 * GET  ?action=withdrawal-lock-status
 * GET  ?action=withdrawal-limits
 * GET  ?action=extra-settings
 * POST ?action=set-method              { method: manual|monnify }
 * POST ?action=set-withdrawal-lock      { locked }
 * POST ?action=set-withdrawal-limits    { min, max }
 * POST ?action=set-bank-details         { bank_name, account_number, account_name }
 * POST ?action=set-welcome-bonus        { enabled, amount }
 * POST ?action=set-invest-gate          { required }
 * POST ?action=set-referral-gate        { required }
 * POST ?action=set-vip-enabled          { enabled }
 * POST ?action=set-withdrawal-fee       { percent }
 * POST ?action=set-referral-settings    { levels, l1, l2, l3 }
 * POST ?action=set-contact-links        { telegram_support_url, telegram_community_url, whatsapp_url, customer_service_url }
 * POST ?action=adjust-wallet            { target_user_id, amount, type, reason }
 * POST ?action=process-deposit          { deposit_id, act }
 * POST ?action=process-withdrawal       { withdrawal_id, act, note }
 * POST ?action=send-message             { user_id, title, content }
 * POST ?action=update-message           { message_id, title, content }
 * POST ?action=delete-message           { message_id }
 * POST ?action=save-product             { id?, name, ... }
 * POST ?action=delete-product           { product_id }
 * POST ?action=toggle-product           { product_id, status }
 * POST ?action=set-admin                { target_user_id, is_admin }
 * POST ?action=ban-user                 { target_user_id }
 * POST ?action=unban-user               { target_user_id }
 * POST ?action=create-gift-code
 * POST ?action=toggle-gift-code
 * POST ?action=delete-gift-code
 */
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function isAdmin(id) {
  if(!id) return false;
  const { data } = await supabase.from("profiles").select("is_admin").eq("id",id).single();
  return !!data?.is_admin;
}

module.exports = async function(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();

  const action = req.query.action;
  const admin_id = req.method==="GET" ? req.query.admin_id : req.body?.admin_id;
  if(!await isAdmin(admin_id)) return res.status(403).json({ error:"Unauthorized" });

  // ── GETs ──────────────────────────────────────────────────────────────────
  if(req.method==="GET") {

    if(action==="deposits") {
      const status = req.query.status||"pending";
      let q = supabase.from("deposits").select("*,profiles!user_id(full_name,email,referral_code)").order("created_at",{ascending:false}).limit(100);
      if(status!=="all") q=q.eq("status",status);
      const { data,error } = await q;
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, deposits:data||[] });
    }

    if(action==="withdrawals") {
      const status = req.query.status||"pending";
      let q = supabase.from("withdrawals").select("*,profiles!user_id(full_name,email)").order("created_at",{ascending:false}).limit(100);
      if(status!=="all") q=q.eq("status",status);
      const { data,error } = await q;
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, withdrawals:data||[] });
    }

    if(action==="users") {
      const { data,error } = await supabase.from("profiles").select("*,wallets(balance)").order("created_at",{ascending:false}).limit(200);
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, users:data||[] });
    }

    if(action==="user-team") {
      const { target_user_id } = req.query;
      if(!target_user_id) return res.status(400).json({ error:"target_user_id required" });

      const { data:l1 } = await supabase.from("profiles").select("id,full_name,email,created_at").eq("referred_by",target_user_id).order("created_at",{ascending:false});
      const l1List = l1||[];
      const l1Ids = l1List.map(m=>m.id);

      let activeSet = new Set();
      if(l1Ids.length) {
        const { data:invested } = await supabase.from("user_products").select("user_id").in("user_id",l1Ids);
        (invested||[]).forEach(r=>activeSet.add(r.user_id));
      }
      const l1WithStatus = l1List.map(m=>({...m, isActive:activeSet.has(m.id)}));

      // Admin view always walks the full 3-level downline for audit purposes,
      // regardless of the referral_levels commission setting — that setting
      // only controls what gets *paid*, not who's actually in the tree.
      let l2List = [];
      if(l1Ids.length) {
        const { data:l2 } = await supabase.from("profiles").select("id,full_name,email,created_at,referred_by").in("referred_by",l1Ids).order("created_at",{ascending:false});
        l2List = l2||[];
      }
      let l3List = [];
      const l2Ids = l2List.map(m=>m.id);
      if(l2Ids.length) {
        const { data:l3 } = await supabase.from("profiles").select("id,full_name,email,created_at").in("referred_by",l2Ids).order("created_at",{ascending:false});
        l3List = l3||[];
      }
      const l3Ids = l3List.map(m=>m.id);
      const allTeamIds = [...l1Ids, ...l2Ids, ...l3Ids];

      let ownDeposits=0, l1Deposits=0, l2Deposits=0, l3Deposits=0;
      const depIds = [target_user_id, ...allTeamIds];
      const { data:deps } = await supabase.from("deposits").select("user_id,amount").eq("status","completed").in("user_id",depIds);
      const l1Set=new Set(l1Ids), l2Set=new Set(l2Ids);
      (deps||[]).forEach(d=>{
        const amt=Number(d.amount||0);
        if(d.user_id===target_user_id) ownDeposits+=amt;
        else if(l1Set.has(d.user_id)) l1Deposits+=amt;
        else if(l2Set.has(d.user_id)) l2Deposits+=amt;
        else l3Deposits+=amt;
      });

      return res.json({
        ok:true,
        l1:l1WithStatus, l2:l2List, l3:l3List,
        active_count: activeSet.size,
        total_team: l1List.length + l2List.length + l3List.length,
        own_deposits: ownDeposits,
        l1_deposits: l1Deposits, l2_deposits: l2Deposits, l3_deposits: l3Deposits,
        total_team_deposits: l1Deposits+l2Deposits+l3Deposits,
        grand_total_deposits: ownDeposits+l1Deposits+l2Deposits+l3Deposits,
      });
    }

    if(action==="products") {
      const { data,error } = await supabase.from("products").select("*").order("sort_order");
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, products:data||[] });
    }

    if(action==="messages") {
      const { data,error } = await supabase.from("messages").select("*, recipient:profiles!user_id(full_name,email)").order("created_at",{ascending:false}).limit(100);
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, messages:data||[] });
    }

    if(action==="gift-codes") {
      const { data,error } = await supabase.from("gift_codes").select("*").order("created_at",{ascending:false}).limit(100);
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, codes:data||[] });
    }

    if(action==="withdrawal-lock-status") {
      const { data } = await supabase.from("site_settings").select("value").eq("key","withdrawals_locked").single();
      return res.json({ ok:true, locked: data?.value === "true" });
    }

    if(action==="withdrawal-limits") {
      const { data } = await supabase.from("site_settings").select("key,value").in("key",["min_withdraw","max_withdraw"]);
      const min = Number(data?.find(s=>s.key==="min_withdraw")?.value || 1000);
      const max = Number(data?.find(s=>s.key==="max_withdraw")?.value || 0);
      return res.json({ ok:true, min, max });
    }

    if(action==="extra-settings") {
      const keys = ["deposit_bank_name","deposit_account_number","deposit_account_name",
        "welcome_bonus_enabled","welcome_bonus_amount","require_invest_before_withdraw",
        "require_active_referral_to_withdraw",
        "vip_enabled","withdrawal_fee_percent","referral_levels",
        "referral_l1_percent","referral_l2_percent","referral_l3_percent",
        "telegram_support_url","telegram_community_url","whatsapp_url","customer_service_url"];
      const { data,error } = await supabase.from("site_settings").select("key,value").in("key",keys);
      if(error) return res.status(500).json({ error:error.message });
      const map={}; (data||[]).forEach(function(r){ map[r.key]=r.value; });
      return res.json({ ok:true, settings:map });
    }

    if(action==="stats") {
      const [d,w,u,p] = await Promise.all([
        supabase.from("deposits").select("id",{count:"exact",head:true}).eq("status","pending"),
        supabase.from("withdrawals").select("id",{count:"exact",head:true}).eq("status","pending"),
        supabase.from("profiles").select("id",{count:"exact",head:true}),
        supabase.from("user_products").select("id",{count:"exact",head:true}).eq("status","active"),
      ]);
      return res.json({ ok:true, pending_deposits:d.count||0, pending_withdrawals:w.count||0, total_users:u.count||0, active_products:p.count||0 });
    }

    return res.status(400).json({ error:"Unknown action" });
  }

  if(req.method!=="POST") return res.status(405).json({ error:"Method not allowed" });

  // ── POSTs ─────────────────────────────────────────────────────────────────
  if(action==="set-method") {
    const { method } = req.body;
    if(!["manual","monnify"].includes(method)) return res.status(400).json({ error:"Invalid method" });
    const { error } = await supabase.from("site_settings").upsert({ key:"deposit_method", value:method, updated_at:new Date().toISOString() });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true, method });
  }

  if(action==="set-withdrawal-lock") {
    const { locked } = req.body;
    const { error } = await supabase.from("site_settings").upsert({ key:"withdrawals_locked", value: locked?"true":"false", updated_at:new Date().toISOString() });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true, locked: !!locked });
  }

  if(action==="set-withdrawal-limits") {
    const { min, max } = req.body;
    const minNum = Number(min), maxNum = Number(max);
    if(isNaN(minNum)||minNum<0) return res.status(400).json({ error:"Invalid minimum amount" });
    if(isNaN(maxNum)||maxNum<0) return res.status(400).json({ error:"Invalid maximum amount" });
    if(maxNum>0 && maxNum<minNum) return res.status(400).json({ error:"Maximum must be greater than minimum (or 0 for no maximum)" });
    await supabase.from("site_settings").upsert([
      { key:"min_withdraw", value:String(minNum), updated_at:new Date().toISOString() },
      { key:"max_withdraw", value:String(maxNum), updated_at:new Date().toISOString() },
    ]);
    return res.json({ ok:true, min:minNum, max:maxNum });
  }

  if(action==="set-bank-details") {
    const { bank_name, account_number, account_name } = req.body;
    if(!bank_name||!account_number||!account_name) return res.status(400).json({ error:"bank_name, account_number, and account_name required" });
    const now=new Date().toISOString();
    const { error } = await supabase.from("site_settings").upsert([
      { key:"deposit_bank_name",      value:String(bank_name).trim(),      updated_at:now },
      { key:"deposit_account_number", value:String(account_number).trim(), updated_at:now },
      { key:"deposit_account_name",   value:String(account_name).trim(),   updated_at:now },
    ]);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="set-welcome-bonus") {
    const { enabled, amount } = req.body;
    const num = Number(amount||0);
    if(isNaN(num)||num<0) return res.status(400).json({ error:"Invalid amount" });
    const now=new Date().toISOString();
    const { error } = await supabase.from("site_settings").upsert([
      { key:"welcome_bonus_enabled", value: enabled?"true":"false", updated_at:now },
      { key:"welcome_bonus_amount",  value:String(num),             updated_at:now },
    ]);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="set-invest-gate") {
    const { required } = req.body;
    const { error } = await supabase.from("site_settings").upsert({ key:"require_invest_before_withdraw", value: required?"true":"false", updated_at:new Date().toISOString() });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="set-referral-gate") {
    const { required } = req.body;
    const { error } = await supabase.from("site_settings").upsert({ key:"require_active_referral_to_withdraw", value: required?"true":"false", updated_at:new Date().toISOString() });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="set-vip-enabled") {
    const { enabled } = req.body;
    const { error } = await supabase.from("site_settings").upsert({ key:"vip_enabled", value: enabled?"true":"false", updated_at:new Date().toISOString() });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="set-withdrawal-fee") {
    const { percent } = req.body;
    const num = Number(percent);
    if(isNaN(num)||num<0||num>100) return res.status(400).json({ error:"Percent must be between 0 and 100" });
    const { error } = await supabase.from("site_settings").upsert({ key:"withdrawal_fee_percent", value:String(num), updated_at:new Date().toISOString() });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="set-referral-settings") {
    const { levels, l1, l2, l3 } = req.body;
    const lv=Number(levels), p1=Number(l1), p2=Number(l2), p3=Number(l3);
    if(![1,3].includes(lv)) return res.status(400).json({ error:"levels must be 1 or 3" });
    if([p1,p2,p3].some(function(n){ return isNaN(n)||n<0||n>100; })) return res.status(400).json({ error:"Percentages must be between 0 and 100" });
    const now=new Date().toISOString();
    const { error } = await supabase.from("site_settings").upsert([
      { key:"referral_levels",     value:String(lv), updated_at:now },
      { key:"referral_l1_percent", value:String(p1), updated_at:now },
      { key:"referral_l2_percent", value:String(p2), updated_at:now },
      { key:"referral_l3_percent", value:String(p3), updated_at:now },
    ]);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="set-contact-links") {
    const { telegram_support_url, telegram_community_url, whatsapp_url, customer_service_url } = req.body;
    const fields = { telegram_support_url, telegram_community_url, whatsapp_url, customer_service_url };
    for(const [key,val] of Object.entries(fields)){
      if(!val || !String(val).trim()) return res.status(400).json({ error:key+" is required" });
    }
    const now=new Date().toISOString();
    const { error } = await supabase.from("site_settings").upsert(
      Object.entries(fields).map(function([key,val]){ return { key, value:String(val).trim(), updated_at:now }; })
    );
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="adjust-wallet") {
    const { target_user_id, amount, type, reason } = req.body;
    if(!target_user_id||!amount||!["credit","debit"].includes(type)) return res.status(400).json({ error:"target_user_id, amount, and type (credit|debit) required" });
    const num = Number(amount);
    if(isNaN(num)||num<=0) return res.status(400).json({ error:"Invalid amount" });

    const { data:wallet } = await supabase.from("wallets").select("balance").eq("user_id",target_user_id).single();
    if(!wallet) return res.status(404).json({ error:"Wallet not found for this user" });

    const delta = type==="credit"?num:-num;
    const newBalance = Number(wallet.balance) + delta;
    if(newBalance < 0) return res.status(400).json({ error:"This would make the balance negative (₦"+newBalance.toLocaleString()+"). Reduce the debit amount." });

    await supabase.from("wallets").update({ balance:newBalance, updated_at:new Date().toISOString() }).eq("user_id",target_user_id);
    await supabase.from("wallet_transactions").insert({ user_id:target_user_id, type: type==="credit"?"admin_credit":"admin_debit", amount: type==="credit"?num:-num, description:"Admin adjustment"+(reason?": "+reason:"") });
    await supabase.from("messages").insert({ user_id:target_user_id, sender_id:null, title: type==="credit"?"Wallet Credited":"Wallet Adjusted", content:`Your wallet was ${type==="credit"?"credited":"debited"} ₦${num.toLocaleString()} by an admin.`+(reason?` Reason: ${reason}`:"") });

    return res.json({ ok:true, new_balance:newBalance });
  }

  if(action==="process-deposit") {
    const { deposit_id, act } = req.body;
    if(!deposit_id||!["approve","reject"].includes(act)) return res.status(400).json({ error:"deposit_id and act required" });
    const { data:dep } = await supabase.from("deposits").select("*").eq("id",deposit_id).single();
    if(!dep) return res.status(404).json({ error:"Not found" });
    if(dep.status==="completed") return res.json({ ok:true, note:"already_completed" });
    if(dep.status==="rejected") return res.json({ ok:true, note:"already_rejected" });
    if(act==="reject") {
      await supabase.from("deposits").update({ status:"rejected", approved_by:admin_id, approved_at:new Date().toISOString(), updated_at:new Date().toISOString() }).eq("id",deposit_id);
      return res.json({ ok:true, action:"rejected" });
    }
    await supabase.from("deposits").update({ approved_by:admin_id, approved_at:new Date().toISOString(), updated_at:new Date().toISOString() }).eq("id",deposit_id);
    const { data,error } = await supabase.rpc("process_deposit", { p_reference:dep.reference, p_amount:dep.amount, p_payload:{ source:"admin_approval", admin_id } });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true, action:"approved", data });
  }

  if(action==="process-withdrawal") {
    const { withdrawal_id, act, note } = req.body;
    if(!withdrawal_id||!["approve","reject"].includes(act)) return res.status(400).json({ error:"withdrawal_id and act required" });
    const { data:w } = await supabase.from("withdrawals").select("*").eq("id",withdrawal_id).single();
    if(!w) return res.status(404).json({ error:"Not found" });
    if(w.status!=="pending") return res.json({ ok:true, note:"already_processed" });
    await supabase.from("withdrawals").update({ status: act==="approve"?"approved":"rejected", note:note||null, processed_by:admin_id, processed_at:new Date().toISOString() }).eq("id",withdrawal_id);
    if(act==="reject") {
      const { data:wallet } = await supabase.from("wallets").select("balance,total_withdrawn").eq("user_id",w.user_id).single();
      const newBal = Number(wallet?.balance||0) + Number(w.amount);
      const newWithdrawn = Math.max(0, Number(wallet?.total_withdrawn||0) - Number(w.amount));
      await supabase.from("wallets").update({ balance:newBal, total_withdrawn:newWithdrawn, updated_at:new Date().toISOString() }).eq("user_id",w.user_id);
      await supabase.from("wallet_transactions").insert({ user_id:w.user_id, type:"withdrawal_refund", amount:w.amount, description:"Withdrawal refunded" });
    }
    return res.json({ ok:true, action:act });
  }

  if(action==="send-message") {
    const { user_id, title, content } = req.body;
    if(!title||!content) return res.status(400).json({ error:"title and content required" });
    const { error } = await supabase.from("messages").insert({ user_id:user_id||null, sender_id:admin_id, title, content });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="update-message") {
    const { message_id, title, content } = req.body;
    if(!message_id||!title||!content) return res.status(400).json({ error:"message_id, title and content required" });
    const { error } = await supabase.from("messages").update({ title, content }).eq("id",message_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="delete-message") {
    const { message_id } = req.body;
    if(!message_id) return res.status(400).json({ error:"message_id required" });
    const { error } = await supabase.from("messages").delete().eq("id",message_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="save-product") {
    const { id, name, description, type, vip_level, price, daily_income, duration_days, total_return, sort_order } = req.body;
    const payload = { name, description, type, vip_level:Number(vip_level||0), price:Number(price), daily_income:Number(daily_income), duration_days:Number(duration_days), total_return:Number(total_return), sort_order:Number(sort_order||0), updated_at:new Date().toISOString() };
    let error;
    if(id) { ({ error } = await supabase.from("products").update(payload).eq("id",id)); }
    else { ({ error } = await supabase.from("products").insert(payload)); }
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="delete-product") {
    const { product_id } = req.body;
    const { error } = await supabase.from("products").delete().eq("id",product_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="toggle-product") {
    const { product_id, status } = req.body;
    const { error } = await supabase.from("products").update({ status, updated_at:new Date().toISOString() }).eq("id",product_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="set-admin") {
    const { target_user_id, is_admin } = req.body;
    const { error } = await supabase.from("profiles").update({ is_admin:!!is_admin }).eq("id",target_user_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="ban-user") {
    const { target_user_id } = req.body;
    if(!target_user_id) return res.status(400).json({ error:"target_user_id required" });
    if(target_user_id === admin_id) return res.status(400).json({ error:"cannot_ban_self" });
    const { data:target } = await supabase.from("profiles").select("is_admin").eq("id",target_user_id).single();
    if(target?.is_admin) return res.status(400).json({ error:"cannot_ban_admin" });
    const { error } = await supabase.from("profiles").update({ is_active:false, updated_at:new Date().toISOString() }).eq("id",target_user_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="unban-user") {
    const { target_user_id } = req.body;
    if(!target_user_id) return res.status(400).json({ error:"target_user_id required" });
    const { error } = await supabase.from("profiles").update({ is_active:true, updated_at:new Date().toISOString() }).eq("id",target_user_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="create-gift-code") {
    const { code, amount, max_uses, expires_at } = req.body;
    if(!code||!amount) return res.status(400).json({ error:"code and amount required" });
    const cleanCode = String(code).trim().toUpperCase();
    const { error } = await supabase.from("gift_codes").insert({ code:cleanCode, amount:Number(amount), max_uses:Number(max_uses||1), uses:0, status:"active", expires_at:expires_at||null });
    if(error) {
      if(error.code==="23505") return res.status(400).json({ error:"This code already exists. Choose a different one." });
      return res.status(500).json({ error:error.message });
    }
    return res.json({ ok:true, code:cleanCode });
  }

  if(action==="toggle-gift-code") {
    const { code_id, status } = req.body;
    const { error } = await supabase.from("gift_codes").update({ status }).eq("id",code_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="delete-gift-code") {
    const { code_id } = req.body;
    const { error } = await supabase.from("gift_codes").delete().eq("id",code_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  return res.status(400).json({ error:"Unknown action: "+action });
};
