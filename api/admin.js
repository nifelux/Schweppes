/**
 * /api/admin.js — All admin actions
 * GET  ?action=deposits&status=&admin_id=   → list deposits
 * GET  ?action=withdrawals&status=          → list withdrawals
 * GET  ?action=users                        → list users
 * GET  ?action=products                     → list products
 * GET  ?action=messages                     → list sent messages
 * GET  ?action=stats                        → dashboard stats
 * POST ?action=set-method                   → switch deposit method
 * POST ?action=process-deposit              → approve/reject deposit
 * POST ?action=process-withdrawal           → approve/reject withdrawal
 * POST ?action=send-message                 → send message to user(s)
 * POST ?action=update-message               → edit an existing message
 * POST ?action=delete-message               → delete a message
 * POST ?action=save-product                 → create/edit product
 * POST ?action=delete-product               → delete product
 * POST ?action=toggle-product               → lock/unlock product
 * POST ?action=set-admin                    → make user admin
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
      // NOTE: "profiles!user_id" disambiguates the FK hint because deposits has
      // TWO foreign keys to profiles (user_id AND approved_by). Without the
      // hint, PostgREST throws an ambiguous-embed error and the row silently
      // disappears from the result (which looked like "deposit not showing").
      let q = supabase.from("deposits")
        .select("*,profiles!user_id(full_name,email,referral_code)")
        .order("created_at",{ascending:false})
        .limit(100);
      if(status!=="all") q=q.eq("status",status);
      const { data,error } = await q;
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, deposits:data||[] });
    }

    if(action==="withdrawals") {
      const status = req.query.status||"pending";
      // Same fix: withdrawals has user_id AND processed_by → both FK to profiles
      let q = supabase.from("withdrawals")
        .select("*,profiles!user_id(full_name,email)")
        .order("created_at",{ascending:false})
        .limit(100);
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

    if(action==="products") {
      const { data,error } = await supabase.from("products").select("*").order("sort_order");
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, products:data||[] });
    }

    if(action==="messages") {
      // messages has user_id (recipient) AND sender_id, both FK to profiles —
      // alias + hint avoids the same ambiguous-embed problem.
      const { data,error } = await supabase
        .from("messages")
        .select("*, recipient:profiles!user_id(full_name,email)")
        .order("created_at",{ascending:false})
        .limit(100);
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, messages:data||[] });
    }

    if(action==="gift-codes") {
      const { data,error } = await supabase
        .from("gift_codes")
        .select("*")
        .order("created_at",{ascending:false})
        .limit(100);
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, codes:data||[] });
    }

    if(action==="unmatched-alerts") {
      const { data,error } = await supabase
        .from("bank_credit_alerts")
        .select("*")
        .eq("status","unmatched")
        .order("received_at",{ascending:false})
        .limit(50);
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, alerts:data||[] });
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


    if(action==="extra-settings") {
      const keys=["bank_name","account_name","account_number","welcome_bonus","require_invest_before_withdraw","require_active_referral_to_withdraw","withdrawal_fee_percent","vip_enabled","referral_depth","referral_percent_l1","referral_percent_l2","referral_percent_l3","support_email","service_phone","telegram_link"];
      const { data,error } = await supabase.from("site_settings").select("key,value").in("key",keys);
      if(error) return res.status(500).json({ error:error.message });
      const settings=Object.fromEntries((data||[]).map(s=>[s.key,s.value]));
      return res.json({ ok:true, settings });
    }

    if(action==="user-team") {
      const target=req.query.user_id;
      if(!target) return res.status(400).json({ error:"user_id required" });
      const { data:user } = await supabase.from("profiles").select("id,full_name,email,referral_code").eq("id",target).single();
      if(!user) return res.status(404).json({ error:"User not found" });
      const { data:members,error } = await supabase.from("profiles").select("id,full_name,email,is_active,vip_level,created_at").eq("referred_by",target).order("created_at",{ascending:false}).limit(200);
      if(error) return res.status(500).json({ error:error.message });
      const ids=(members||[]).map(m=>m.id);
      let activeCount=0, teamDeposits=0;
      if(ids.length){
        const { count } = await supabase.from("user_products").select("id",{count:"exact",head:true}).in("user_id",ids).eq("status","active");
        activeCount=count||0;
        const { data:deps } = await supabase.from("deposits").select("amount").in("user_id",ids).eq("status","completed");
        teamDeposits=(deps||[]).reduce((sum,d)=>sum+Number(d.amount||0),0);
      }
      return res.json({ ok:true, owner:user, members:members||[], active_investors:activeCount, team_deposits:teamDeposits });
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

    return res.status(400).json({ error:"Unknown action" });
  }

  if(req.method!=="POST") return res.status(405).json({ error:"Method not allowed" });

  // ── POSTs ─────────────────────────────────────────────────────────────────

  if(action==="set-extra-settings") {
    const allowed=["bank_name","account_name","account_number","welcome_bonus","require_invest_before_withdraw","require_active_referral_to_withdraw","withdrawal_fee_percent","vip_enabled","referral_depth","referral_percent_l1","referral_percent_l2","referral_percent_l3","support_email","service_phone","telegram_link"];
    const payload=req.body?.settings||{};
    const rows=allowed.filter(key=>payload[key]!==undefined).map(key=>({ key, value:String(payload[key]), updated_at:new Date().toISOString() }));
    if(!rows.length) return res.status(400).json({ error:"No settings supplied" });
    const { error } = await supabase.from("site_settings").upsert(rows);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="set-method") {
    const { method } = req.body;
    if(!["manual","paystack","ipayng"].includes(method)) return res.status(400).json({ error:"Invalid method" });
    const { error } = await supabase.from("site_settings").upsert({ key:"deposit_method", value:method, updated_at:new Date().toISOString() });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true, method });
  }

  if(action==="set-withdrawal-lock") {
    const { locked } = req.body;
    const { error } = await supabase.from("site_settings")
      .upsert({ key:"withdrawals_locked", value: locked ? "true" : "false", updated_at:new Date().toISOString() });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true, locked: !!locked });
  }

  if(action==="set-withdrawal-limits") {
    const { min, max } = req.body;
    const minNum = Number(min);
    const maxNum = Number(max);
    if(isNaN(minNum) || minNum < 0) return res.status(400).json({ error:"Invalid minimum amount" });
    if(isNaN(maxNum) || maxNum < 0) return res.status(400).json({ error:"Invalid maximum amount" });
    if(maxNum > 0 && maxNum < minNum) return res.status(400).json({ error:"Maximum must be greater than minimum (or 0 for no maximum)" });

    await supabase.from("site_settings").upsert([
      { key:"min_withdraw", value:String(minNum), updated_at:new Date().toISOString() },
      { key:"max_withdraw", value:String(maxNum), updated_at:new Date().toISOString() },
    ]);
    return res.json({ ok:true, min:minNum, max:maxNum });
  }

  if(action==="adjust-wallet") {
    const { target_user_id, amount, type, reason } = req.body;
    if(!target_user_id || !amount || !["credit","debit"].includes(type)) {
      return res.status(400).json({ error:"target_user_id, amount, and type (credit|debit) required" });
    }
    const num = Number(amount);
    if(isNaN(num) || num <= 0) return res.status(400).json({ error:"Invalid amount" });

    const { data:wallet } = await supabase.from("wallets").select("balance").eq("user_id",target_user_id).single();
    if(!wallet) return res.status(404).json({ error:"Wallet not found for this user" });

    const delta = type==="credit" ? num : -num;
    const newBalance = Number(wallet.balance) + delta;
    if(newBalance < 0) {
      return res.status(400).json({ error:"This would make the balance negative (₦"+newBalance.toLocaleString()+"). Reduce the debit amount." });
    }

    await supabase.from("wallets").update({ balance:newBalance, updated_at:new Date().toISOString() }).eq("user_id",target_user_id);

    await supabase.from("wallet_transactions").insert({
      user_id: target_user_id,
      type: type==="credit" ? "admin_credit" : "admin_debit",
      amount: type==="credit" ? num : -num,
      description: "Admin adjustment" + (reason ? ": "+reason : "") ,
    });

    // Let the user see why their balance changed
    await supabase.from("messages").insert({
      user_id: target_user_id, sender_id: null,
      title: type==="credit" ? "Wallet Credited" : "Wallet Adjusted",
      content: `Your wallet was ${type==="credit"?"credited":"debited"} ₦${num.toLocaleString()} by an admin.` + (reason ? ` Reason: ${reason}` : ""),
    });

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
    const { data,error } = await supabase.rpc("process_deposit",{ p_reference:dep.reference, p_amount:dep.amount, p_payload:{ source:"admin_approval", admin_id } });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true, action:"approved", data });
  }

  if(action==="process-withdrawal") {
    const { withdrawal_id, act, note } = req.body;
    if(!withdrawal_id||!["approve","reject"].includes(act)) return res.status(400).json({ error:"withdrawal_id and act required" });
    const { data:w } = await supabase.from("withdrawals").select("*").eq("id",withdrawal_id).single();
    if(!w) return res.status(404).json({ error:"Not found" });
    if(w.status!=="pending") return res.json({ ok:true, note:"already_processed" });
    await supabase.from("withdrawals").update({ status:act==="approve"?"approved":"rejected", note:note||null, processed_by:admin_id, processed_at:new Date().toISOString() }).eq("id",withdrawal_id);
    if(act==="reject") {
      // Refund the wallet (FIXED: supabase.raw() is not a real function in
      // supabase-js v2 — that was a Knex-style call that would always throw).
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


  if(action==="set-user-active") {
    const { target_user_id, is_active } = req.body;
    if(!target_user_id) return res.status(400).json({ error:"target_user_id required" });
    if(target_user_id===admin_id && is_active===false) return res.status(400).json({ error:"You cannot suspend your own account" });
    const { data:target } = await supabase.from("profiles").select("id,is_admin").eq("id",target_user_id).single();
    if(!target) return res.status(404).json({ error:"User not found" });
    if(target.is_admin && is_active===false) return res.status(400).json({ error:"Remove admin access before suspending an administrator" });
    const { error } = await supabase.from("profiles").update({ is_active:!!is_active }).eq("id",target_user_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true, is_active:!!is_active });
  }

  if(action==="create-gift-code") {
    const { code, amount, max_uses, expires_at } = req.body;
    if(!code || !amount) return res.status(400).json({ error:"code and amount required" });
    const cleanCode = String(code).trim().toUpperCase();
    if(!cleanCode) return res.status(400).json({ error:"Invalid code" });
    const { error } = await supabase.from("gift_codes").insert({
      code: cleanCode,
      amount: Number(amount),
      max_uses: Number(max_uses||1),
      uses: 0,
      status: "active",
      expires_at: expires_at || null,
    });
    if(error) {
      if(error.code === "23505") return res.status(400).json({ error:"This code already exists. Choose a different one." });
      return res.status(500).json({ error:error.message });
    }
    return res.json({ ok:true, code:cleanCode });
  }

  if(action==="toggle-gift-code") {
    const { code_id, status } = req.body;
    if(!code_id) return res.status(400).json({ error:"code_id required" });
    const { error } = await supabase.from("gift_codes").update({ status }).eq("id",code_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="delete-gift-code") {
    const { code_id } = req.body;
    if(!code_id) return res.status(400).json({ error:"code_id required" });
    const { error } = await supabase.from("gift_codes").delete().eq("id",code_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="manual-match-alert") {
    const { alert_id, deposit_reference } = req.body;
    if(!alert_id || !deposit_reference) return res.status(400).json({ error:"alert_id and deposit_reference required" });

    const { data:alert } = await supabase.from("bank_credit_alerts").select("*").eq("id",alert_id).single();
    if(!alert) return res.status(404).json({ error:"Alert not found" });

    const { data:dep } = await supabase.from("deposits").select("*").eq("reference",deposit_reference.trim()).single();
    if(!dep) return res.status(404).json({ error:"Deposit not found — check the reference" });
    if(dep.status==="completed") return res.json({ ok:true, note:"already_completed" });

    await supabase.from("bank_credit_alerts").update({ status:"matched", matched_deposit_id:dep.id }).eq("id",alert_id);

    const { data,error } = await supabase.rpc("process_deposit", {
      p_reference: dep.reference,
      p_amount:    alert.amount,
      p_payload:   { source:"admin_manual_alert_match", alert_id },
    });
    if(error) return res.status(500).json({ error:error.message });
    if(!data?.ok) return res.json({ ok:true, note:data?.error });
    return res.json({ ok:true, data });
  }

  return res.status(400).json({ error:"Unknown action: "+action });
};
