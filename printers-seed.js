/* Dữ liệu nhập sẵn từ file 'Theo dõi sửa máy in DNP 18/09/2026' (nút 'Nạp dữ liệu DNP' trong module Máy in — chạy nhiều lần vẫn không trùng). */
window.PR_SEED_DNP = {
 "vendor": {
  "name": "DNP",
  "role": "Cho thuê",
  "roles": [
   "Cho thuê",
   "Sửa chữa/bảo trì"
  ],
  "note": "Đối tác cho thuê & sửa chữa máy in (theo file theo dõi sửa máy in 18/09/2026)",
  "taxCode": "1301009248",
  "receiverName": "CÔNG TY TNHH MỘT THÀNH VIÊN VI TÍNH - ĐIỆN TỬ D N P",
  "bankAccount": "114000189658",
  "bankName": "Ngân Hàng TMCP Công Thương Việt Nam - CN Bến Tre"
 },
 "printers": [
  {
   "seedKey": "dnp-P1",
   "brand": "Canon",
   "model": "LBP633Cdw",
   "serial": "",
   "type": "Laser màu",
   "section": "Văn phòng",
   "location": "Văn phòng"
  },
  {
   "seedKey": "dnp-P2",
   "brand": "Brother",
   "model": "DCP-L3560CDW",
   "serial": "E81703J3N219227",
   "type": "Laser màu",
   "section": "Phòng Lab",
   "location": "Phòng Lab"
  },
  {
   "seedKey": "dnp-P3",
   "brand": "Canon",
   "model": "LBP633Cdw",
   "serial": "",
   "type": "Laser màu",
   "section": "Nhân sự",
   "location": "Nhân sự"
  },
  {
   "seedKey": "dnp-P4",
   "brand": "Canon",
   "model": "Trắng đen (chưa rõ model)",
   "serial": "",
   "type": "Laser đen trắng",
   "section": "QC",
   "location": "QC"
  },
  {
   "seedKey": "dnp-P5",
   "brand": "Canon",
   "model": "Trắng đen (chưa rõ model)",
   "serial": "",
   "type": "Laser đen trắng",
   "section": "Kho",
   "location": "Kho"
  },
  {
   "seedKey": "dnp-P6",
   "brand": "",
   "model": "Photo HR",
   "serial": "",
   "type": "Photocopy",
   "section": "HR",
   "location": "HR",
   "upgrade": {
    "from": {
     "model": "Photo HR",
     "brand": ""
    },
    "set": {
     "brand": "Toshiba",
     "model": "4508A",
     "monthlyFee": 925926,
     "vatRate": 8,
     "includedPages": 7000,
     "extraPageFee": 92.59
    }
   }
  }
 ],
 "repairs": [
  {
   "issue": "Máy in sọc, vệ sinh gạt mực màu hồng.",
   "description": "Đề nghị thay gạt mực màu hồng.",
   "result": "Đã xử lí tạm",
   "resultStatus": "Thành công",
   "id": "dnp-20260803-P1",
   "date": "2026-08-03",
   "printerKey": "dnp-P1",
   "kind": "Sửa chữa",
   "next": "",
   "cost": 0
  },
  {
   "issue": "Hết chip mực màu đen",
   "description": "Đề xuất thay chip mới.",
   "result": "DNP hẹn thay vào chuyến sau",
   "resultStatus": "Đang theo dõi",
   "id": "dnp-20260803-P2",
   "date": "2026-08-03",
   "printerKey": "dnp-P2",
   "kind": "Sửa chữa",
   "next": "",
   "cost": 0
  },
  {
   "issue": "Máy in mờ, sọc",
   "description": "Thay gạt mực màu vàng của DNP, thay 2 hộp mực dự phòng hồng, xanh dương của SEC",
   "result": "Máy sử dụng bình thường",
   "resultStatus": "Thành công",
   "id": "dnp-20260803-P3",
   "date": "2026-08-03",
   "printerKey": "dnp-P3",
   "kind": "Thay linh kiện",
   "next": "",
   "cost": 0
  },
  {
   "issue": "Máy in mờ sọc",
   "description": "Hộp mực hồng: bơm mực; vệ sinh gạt; thay thế cây từ (linh kiện của SEC)",
   "result": "In vẫn sọc ở mép giấy (màu hồng)",
   "resultStatus": "Đang theo dõi",
   "next": "Thay gạt và drum hộp mực màu hồng",
   "id": "dnp-20260811-P1",
   "date": "2026-08-11",
   "printerKey": "dnp-P1",
   "kind": "Thay linh kiện",
   "cost": 0
  },
  {
   "issue": "Tạm ngừng sử dụng",
   "description": "Thay 1 chip mực màu đen",
   "result": "Không thành công",
   "resultStatus": "Chưa thành công",
   "next": "Thay lại chip này",
   "id": "dnp-20260811-P2",
   "date": "2026-08-11",
   "printerKey": "dnp-P2",
   "kind": "Thay linh kiện",
   "cost": 0
  },
  {
   "issue": "Máy in mờ mực màu đen",
   "description": "Thay thế bằng hộp mực dự phòng của SEC",
   "result": "Ok",
   "resultStatus": "Thành công",
   "next": "Ok",
   "id": "dnp-20260814-P1",
   "date": "2026-08-14",
   "printerKey": "dnp-P1",
   "kind": "Thay mực/drum",
   "cost": 0
  },
  {
   "issue": "Tạm ngừng sử dụng",
   "description": "Thay 1 chip mực màu đen và vệ sinh hộp mực",
   "result": "Ok",
   "resultStatus": "Thành công",
   "id": "dnp-20260814-P2",
   "date": "2026-08-14",
   "printerKey": "dnp-P2",
   "kind": "Thay linh kiện",
   "next": "",
   "cost": 0
  },
  {
   "result": "Ok",
   "resultStatus": "Thành công",
   "description": "Kiểm tra lại sau lần xử lý trước (file không ghi nội dung xử lý)",
   "id": "dnp-20260814-P3",
   "date": "2026-08-14",
   "printerKey": "dnp-P3",
   "kind": "Sửa chữa",
   "issue": "",
   "next": "",
   "cost": 0
  },
  {
   "issue": "Mờ",
   "description": "Bơm mực",
   "result": "Ok",
   "resultStatus": "Thành công",
   "next": "Thay drum",
   "id": "dnp-20260814-P4",
   "date": "2026-08-14",
   "printerKey": "dnp-P4",
   "kind": "Thay mực/drum",
   "cost": 0
  },
  {
   "issue": "In mờ, sọc",
   "description": "Thay mực, vệ sinh toàn bộ máy",
   "result": "Còn sọc xanh, do drum",
   "resultStatus": "Đang theo dõi",
   "next": "Thay drum",
   "id": "dnp-20260828-P1",
   "date": "2026-08-28",
   "printerKey": "dnp-P1",
   "kind": "Thay mực/drum",
   "cost": 0
  },
  {
   "issue": "In mờ",
   "description": "Thay mực, vệ sinh",
   "result": "Ok",
   "resultStatus": "Thành công",
   "id": "dnp-20260828-P5",
   "date": "2026-08-28",
   "printerKey": "dnp-P5",
   "kind": "Thay mực/drum",
   "next": "",
   "cost": 0
  },
  {
   "description": "Thay gạt mực hồng (thiết bị DNP)",
   "next": "Đề xuất thay drum xanh",
   "id": "dnp-20260910-P1",
   "date": "2026-09-10",
   "printerKey": "dnp-P1",
   "kind": "Thay linh kiện",
   "issue": "",
   "result": "",
   "resultStatus": "",
   "cost": 0
  },
  {
   "description": "Ép hơi mềm nên tăng nhiệt độ không hiệu quả",
   "next": "Đề xuất thay ép",
   "id": "dnp-20260910-P6",
   "date": "2026-09-10",
   "printerKey": "dnp-P6",
   "kind": "Sửa chữa",
   "issue": "",
   "result": "",
   "resultStatus": "",
   "cost": 0
  },
  {
   "description": "Bơm 4 bình mực",
   "next": "Đề xuất thay gạt lớn xanh, drum xanh",
   "id": "dnp-20260918-P1",
   "date": "2026-09-18",
   "printerKey": "dnp-P1",
   "kind": "Thay mực/drum",
   "issue": "",
   "result": "",
   "resultStatus": "",
   "cost": 0
  },
  {
   "description": "Vệ sinh gạt mực hồng, xanh; in chưa đẹp",
   "next": "Thay gạt mực Brother 4 màu",
   "id": "dnp-20260918-P2",
   "date": "2026-09-18",
   "printerKey": "dnp-P2",
   "kind": "Sửa chữa",
   "issue": "",
   "result": "",
   "resultStatus": "",
   "cost": 0
  },
  {
   "description": "Lỗi không nhận ổ cứng",
   "next": "Tháo ổ cứng đem về kiểm tra",
   "id": "dnp-20260918-P6",
   "date": "2026-09-18",
   "printerKey": "dnp-P6",
   "kind": "Sửa chữa",
   "issue": "",
   "result": "",
   "resultStatus": "",
   "cost": 0
  }
 ],
 "rev": 2
};
