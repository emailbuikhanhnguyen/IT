const TYPES=["PC","Laptop","Monitor","Printer","Camera","NVR/DVR","WiFi AP","Điện thoại","Thiết bị khác"];
const $=id=>document.getElementById(id);
let photoData=null,scanner=null;

// ==== Firebase (Firestore + Storage) — thay cho IndexedDB local ====
const firebaseConfig = {
  apiKey: "AIzaSyC5W2yjCUZzTZOcFMAbD2uj9bo9rmGydEI",
  authDomain: "sec-it-asset.firebaseapp.com",
  projectId: "sec-it-asset",
  storageBucket: "sec-it-asset.firebasestorage.app",
  messagingSenderId: "936361007231",
  appId: "1:936361007231:web:3fbf98db47f74801d1c74a"
};
firebase.initializeApp(firebaseConfig);
const dbFS = firebase.firestore();
const storage = firebase.storage();
const ASSETS = dbFS.collection("assets");
// Cho phép app hoạt động offline (cache local), tự đồng bộ khi có mạng lại
dbFS.enablePersistence().catch(err=>console.warn("Không bật được chế độ offline:",err.code));

// ==== Các hàm thao tác dữ liệu dùng chung cho cả app ====
// Dùng "code" (Mã tài sản) làm ID tài liệu trên Firestore -> QR luôn trỏ đúng 1 bản ghi, không trùng
async function all(){
  const snap=await ASSETS.get();
  return snap.docs.map(d=>({...d.data(),code:d.id}));
}
async function put(x){
  if(!x.code)throw new Error("Thiếu Mã tài sản");
  const {code,...data}=x;
  await ASSETS.doc(code).set(data,{merge:true});
  return code;
}
async function del(code){await ASSETS.doc(code).delete()}
async function clearDB(){
  const snap=await ASSETS.get();
  let docs=snap.docs;
  while(docs.length){
    const chunk=docs.splice(0,400); // giới hạn 1 batch Firestore là 500
    const batch=dbFS.batch();
    chunk.forEach(d=>batch.delete(d.ref));
    await batch.commit();
  }
}

function esc(s=""){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
function showPage(id){if(id!=="scan")stopScanner();document.querySelectorAll(".page").forEach(p=>p.classList.toggle("active",p.id===id));if(id==="dashboard")dashboard();if(id==="assets")renderAssets();window.scrollTo(0,0)}
document.addEventListener("click",e=>{let b=e.target.closest("[data-page]");if(b)showPage(b.dataset.page)});
function initTypes(){let s=$("type");TYPES.forEach(t=>{let o=document.createElement("option");o.value=o.textContent=t;s.appendChild(o)})}

async function dashboard(){
  let a=await all();
  let checked=a.filter(x=>x.checkStatus==="Đã kiểm - OK").length;
  let ex=a.filter(x=>["Sai thông tin","Không tìm thấy","Thiết bị mới"].includes(x.checkStatus)).length;
  $("totalCount").textContent=a.length;
  $("checkedCount").textContent=checked;
  $("uncheckedCount").textContent=a.length-checked;
  $("exceptionCount").textContent=ex;
  let c={};
  a.forEach(x=>c[x.checkStatus]=(c[x.checkStatus]||0)+1);
  $("checkStats").innerHTML=Object.keys(c).length?Object.entries(c).map(([k,v])=>`<div><b>${esc(k)}</b> — ${v}<div class="bar"><i style="width:${a.length?v/a.length*100:0}%"></i></div></div>`).join(""):`<div class="empty">Chưa có dữ liệu</div>`;
}

async function renderAssets(){
  let a=await all(),q=$("search").value.toLowerCase(),ar=$("filterArea").value,fc=$("filterCheck").value;
  if(ar)a=a.filter(x=>x.area===ar);
  if(fc==="checked")a=a.filter(x=>x.checkStatus==="Đã kiểm - OK");
  if(fc==="unchecked")a=a.filter(x=>x.checkStatus==="Chưa kiểm");
  if(fc==="exception")a=a.filter(x=>["Sai thông tin","Không tìm thấy","Thiết bị mới"].includes(x.checkStatus));
  a=a.filter(x=>!q||Object.values(x).join(" ").toLowerCase().includes(q));
  let areas=[...new Set((await all()).map(x=>x.area).filter(Boolean))];
  $("filterArea").innerHTML='<option value="">Tất cả khu vực</option>'+areas.map(x=>`<option>${esc(x)}</option>`).join("");
  $("filterArea").value=ar;
  $("assetList").innerHTML=a.length?a.map(x=>{
    let cls=x.checkStatus==="Đã kiểm - OK"?"ok":x.checkStatus==="Chưa kiểm"?"warn":"bad";
    return `<article class="asset"><div><h3>${esc(x.code)} ${x.checkStatus==="Đã kiểm - OK"?"✓":""}</h3><div class="muted">${esc(x.type)} · ${esc(x.assetName||x.model||"Chưa có tên")}</div><div class="muted">${esc(x.area||"Chưa có khu vực")} · ${esc(x.user||"Chưa cấp")}</div><span class="badge ${cls}">${esc(x.checkStatus)}</span></div><div class="asset-actions"><button data-edit="${esc(x.code)}">Sửa</button><button class="secondary" data-qr="${esc(x.code)}">QR</button></div></article>`;
  }).join(""):`<div class="empty">Không có tài sản phù hợp.</div>`;
}
["search","filterArea","filterCheck"].forEach(id=>$(id).addEventListener("input",renderAssets));
document.addEventListener("click",async e=>{
  let code=e.target.dataset.edit;
  if(code)editAsset(code);
  let qcode=e.target.dataset.qr;
  if(qcode){await editAsset(qcode);showPage("assetForm")}
});

function resetForm(){$("assetFormEl").reset();$("assetId").value="";$("formTitle").textContent="Tạo tài sản";photoData=null;$("photoPreview").classList.add("hidden");$("qrcode").innerHTML="";$("qrText").textContent=""}
async function editAsset(code){
  const doc=await ASSETS.doc(code).get();
  if(!doc.exists)return;
  const x={...doc.data(),code:doc.id};
  showPage("assetForm");
  $("formTitle").textContent="Cập nhật tài sản";
  ["code","type","assetName","model","serial","ip","mac","spec","area","user","status","checkStatus","note"].forEach(k=>{if($(k))$(k).value=x[k]??""});
  $("assetId").value=x.code; // luu ma goc de biet dang o che do sua + phat hien neu doi ma
  photoData=x.photo||null;
  if(photoData){$("photoPreview").src=photoData;$("photoPreview").classList.remove("hidden")}
  makeQR(x.code);
}
function makeQR(code){$("qrcode").innerHTML="";if(!code)return;new QRCode($("qrcode"),{text:"ITASSET:"+code,width:210,height:210});$("qrText").textContent="ITASSET:"+code}
$("code").addEventListener("input",()=>makeQR($("code").value.trim()));
$("resetForm").onclick=resetForm;
$("photo").onchange=e=>{let f=e.target.files[0];if(!f)return;let r=new FileReader();r.onload=()=>{photoData=r.result;$("photoPreview").src=photoData;$("photoPreview").classList.remove("hidden")};r.readAsDataURL(f)};
$("takePhoto").onclick=()=>{$("photo").click()};
$("downloadQR").onclick=()=>{let c=$("qrcode").querySelector("canvas")||$("qrcode").querySelector("img");if(!c)return alert("Chưa có QR");let a=document.createElement("a");a.download=($("code").value||"asset")+"-QR.png";a.href=c.tagName==="CANVAS"?c.toDataURL("image/png"):c.src;a.click()};

$("assetFormEl").onsubmit=async e=>{
  e.preventDefault();
  const code=$("code").value.trim();
  if(!code){alert("Thiếu Mã tài sản");return}
  const btn=e.target.querySelector('button[type="submit"]');
  if(btn){btn.disabled=true;btn.textContent="Đang lưu..."}
  try{
    let photoUrl=null;
    if(photoData&&photoData.startsWith("data:")){
      // Ảnh mới chụp/chọn (base64) -> upload lên Firebase Storage, chỉ lưu link vào Firestore
      const path="photos/"+code+"_"+Date.now()+".jpg";
      const ref=storage.ref(path);
      await ref.putString(photoData,"data_url");
      photoUrl=await ref.getDownloadURL();
    }else{
      photoUrl=photoData||null; // giữ nguyên link ảnh cũ nếu không đổi ảnh
    }
    let x={code,type:$("type").value,assetName:$("assetName").value.trim(),model:$("model").value.trim(),serial:$("serial").value.trim(),ip:$("ip").value.trim(),mac:$("mac").value.trim(),spec:$("spec").value.trim(),area:$("area").value.trim(),user:$("user").value.trim(),status:$("status").value,checkStatus:$("checkStatus").value,note:$("note").value.trim(),photo:photoUrl,updatedAt:new Date().toISOString()};
    const oldCode=$("assetId").value;
    if(oldCode&&oldCode!==code){await del(oldCode)} // đổi Mã tài sản khi sửa -> coi như đổi tên bản ghi
    await put(x);
    makeQR(code);
    alert("Đã lưu lên Firebase. QR đã được tạo.");
    dashboard();
  }catch(err){
    alert("Lỗi khi lưu lên Firebase: "+err.message);
  }finally{
    if(btn){btn.disabled=false;btn.textContent="Lưu tài sản"}
  }
};

async function startScanner(){if(scanner)return;scanner=new Html5Qrcode("reader");try{await scanner.start({facingMode:"environment"},{fps:10,qrbox:{width:240,height:240}},async text=>{await handleQR(text)},()=>{});$("scanResult").textContent="Đang quét...";$("scanResult").classList.remove("hidden")}catch(e){scanner=null;alert("Không mở được camera. Hãy cấp quyền camera và dùng HTTPS hoặc localhost.")}}
async function stopScanner(){if(!scanner)return;try{await scanner.stop()}catch(e){}try{scanner.clear()}catch(e){}scanner=null}
async function handleQR(text){
  let code=text.replace(/^ITASSET:/i,"").trim();
  const doc=await ASSETS.doc(code).get();
  if(!doc.exists){
    $("scanResult").innerHTML=`<b>Không tìm thấy:</b> ${esc(code)}<br><br><button onclick="newFromScan('${esc(code)}')">＋ Tạo tài sản mới</button>`;
    $("scanResult").classList.remove("hidden");
    return;
  }
  stopScanner();
  showPage("assetForm");
  await editAsset(code);
  $("checkStatus").value="Đã kiểm - OK";
}
window.newFromScan=code=>{resetForm();$("code").value=code;makeQR(code);showPage("assetForm");$("checkStatus").value="Thiết bị mới"};
$("startScan").onclick=startScanner;$("stopScan").onclick=stopScanner;

$("exportXlsx").onclick=async()=>{let a=await all();if(!a.length)return alert("Chưa có dữ liệu");let rows=a.map(({photo,...x})=>x);let ws=XLSX.utils.json_to_sheet(rows),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"Assets");XLSX.writeFile(wb,"IT_Asset_Inventory.xlsx")};
$("importXlsx").onchange=async e=>{
  let f=e.target.files[0];if(!f)return;
  try{
    let wb=XLSX.read(await f.arrayBuffer()),rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""}),n=0,autoN=0;
    for(let r of rows){
      let x={code:r.code||r["Mã tài sản"]||r["Asset Code"]||"",type:r.type||r["Loại tài sản"]||r["Loại"]||"PC",assetName:r.assetName||r["Tên tài sản"]||"",model:r.model||r["Model"]||"",serial:r.serial||r["Serial"]||"",ip:r.ip||r["IP"]||"",mac:r.mac||r["MAC"]||"",spec:r.spec||r["Cấu hình"]||"",area:r.area||r["Phòng ban"]||r["Khu vực"]||"PHÒNG LAB",user:r.user||r["Người sử dụng"]||"",status:r.status||r["Tình trạng"]||"Tốt",checkStatus:r.checkStatus||r["Trạng thái kiểm kê"]||"Chưa kiểm",note:r.note||r["Ghi chú"]||"",updatedAt:new Date().toISOString()};
      if(!x.code){autoN++;x.code="LAB-"+String(autoN).padStart(3,"0")} // tự sinh mã cho dòng thiếu mã
      await put(x);n++;
    }
    alert("Đã nhập "+n+" tài sản lên Firebase");
    renderAssets();dashboard();e.target.value=""
  }catch(err){alert("Không đọc được Excel: "+err.message)}
};
$("backupJson").onclick=async()=>{let b=new Blob([JSON.stringify(await all(),null,2)],{type:"application/json"});download(b,"IT_Asset_Backup.json")};
$("restoreJson").onchange=async e=>{try{let a=JSON.parse(await e.target.files[0].text());for(let x of a)await put(x);alert("Đã khôi phục lên Firebase");dashboard();renderAssets()}catch(err){alert("Backup không hợp lệ")}};

$("clearAll").onclick=async()=>{
  let list=await all();
  if(!list.length)return alert("Không có dữ liệu để xóa.");
  if(!confirm(`Sắp XÓA TOÀN BỘ ${list.length} tài sản trên Firebase — ẢNH HƯỞNG TẤT CẢ MỌI NGƯỜI đang dùng chung app. Không thể hoàn tác. Tiếp tục?`))return;
  let typed=prompt('Để xác nhận, gõ đúng chữ XOA (viết hoa, không dấu) rồi bấm OK:');
  if(typed!=="XOA"){alert("Đã hủy, chưa xóa gì cả.");return}
  let b=new Blob([JSON.stringify(list,null,2)],{type:"application/json"});
  download(b,"IT_Asset_Backup_truockhi_xoa_"+new Date().toISOString().slice(0,10)+".json");
  await clearDB();dashboard();renderAssets();
  alert("Đã xóa toàn bộ trên Firebase. App vừa tự tải về 1 bản backup JSON trước khi xóa, đề phòng cần khôi phục lại.");
};

function download(b,n){let u=URL.createObjectURL(b),a=document.createElement("a");a.href=u;a.download=n;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}
let deferredPrompt;window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();deferredPrompt=e;$("installBtn").classList.remove("hidden")});$("installBtn").onclick=async()=>{if(deferredPrompt){deferredPrompt.prompt();deferredPrompt=null}};
if("serviceWorker"in navigator)navigator.serviceWorker.register("sw.js");
initTypes();dashboard();

// ==== Copy lệnh PowerShell để lấy thông tin máy (get-info.ps1) ====
const PS_SCRIPT = [
  '$cs   = Get-CimInstance Win32_ComputerSystem',
  '$bios = Get-CimInstance Win32_BIOS',
  '$cpu  = (Get-CimInstance Win32_Processor).Name',
  '',
  '$ramBytes = (Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum).Sum',
  '$ramGB    = [math]::Round($ramBytes / 1GB, 0)',
  '',
  '$disk   = Get-CimInstance Win32_DiskDrive | Select-Object -First 1',
  '$diskGB = [math]::Round($disk.Size / 1GB, 0)',
  '',
  '$ip = Get-NetIPAddress -AddressFamily IPv4 |',
  '      Where-Object { $_.InterfaceAlias -notmatch "Loopback" -and $_.IPAddress -notlike "169.254*" } |',
  '      Select-Object -First 1 -ExpandProperty IPAddress',
  '',
  '# Uu tien card mang vat ly dang Up (bo qua VPN/Bluetooth/Hyper-V ao);',
  '# neu khong co card nao dang Up thi lay card vat ly dau tien tim duoc',
  '$macAdapter = Get-NetAdapter -Physical | Where-Object { $_.Status -eq "Up" } | Select-Object -First 1',
  'if (-not $macAdapter) { $macAdapter = Get-NetAdapter -Physical | Select-Object -First 1 }',
  '$mac = if ($macAdapter) { $macAdapter.MacAddress } else { "" }',
  '',
  'Write-Output "----- COPY TU DAY -----"',
  'Write-Output "MODEL: $($cs.Manufacturer) $($cs.Model)"',
  'Write-Output "SERIAL: $($bios.SerialNumber)"',
  'Write-Output "CAUHINH: $cpu / RAM ${ramGB}GB / O cung ${diskGB}GB"',
  'Write-Output "IP: $ip"',
  'Write-Output "MAC: $mac"',
  'Write-Output "----- DEN DAY -----"'
].join("\n");

if($("btnCopyPS")){
  $("btnCopyPS").onclick=async()=>{
    try{
      await navigator.clipboard.writeText(PS_SCRIPT);
      alert("Đã copy lệnh PowerShell vào clipboard.\nMở PowerShell trên máy này → Ctrl+V (hoặc chuột phải) → Enter.");
    }catch(e){
      prompt("Không tự copy được (thiếu quyền clipboard). Hãy tự bôi đen & Copy đoạn dưới:",PS_SCRIPT);
    }
  };
}

// ==== Dán thông tin máy (Model/Serial/Cấu hình/IP/MAC) & tự động điền ====
function autofillFromPastedText(text){
  const map={MODEL:"model",SERIAL:"serial",CAUHINH:"spec",IP:"ip",MAC:"mac"};
  let n=0;
  text.split("\n").forEach(line=>{
    const m=line.match(/^([A-Za-z]+)\s*:\s*(.+)$/);
    if(!m)return;
    const key=m[1].trim().toUpperCase();
    const field=map[key];
    const val=m[2].trim();
    if(field&&val&&$(field)){$(field).value=val;n++}
  });
  return n;
}
if($("btnAutofill")){
  $("btnAutofill").onclick=()=>{
    const box=$("pasteInfoBox");
    const n=autofillFromPastedText(box.value);
    alert(n?("Đã tự động điền "+n+" ô."):"Không nhận diện được dòng nào. Kiểm tra định dạng: MODEL: ...");
  };
}
