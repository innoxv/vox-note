// test-with-pdfreader.js
const { PdfReader } = require("pdfreader");
const fs = require("fs");

async function parsePDF(filePath) {
  return new Promise((resolve, reject) => {
    const textByPage = {};
    
    new PdfReader().parseFileItems(filePath, (err, item) => {
      if (err) {
        reject(err);
      } else if (!item) {
        // End of file
        const fullText = Object.values(textByPage).join("\n");
        resolve({
          text: fullText,
          numPages: Object.keys(textByPage).length,
          pages: textByPage
        });
      } else if (item.page) {
        // Initialize page text
        if (!textByPage[item.page]) {
          textByPage[item.page] = "";
        }
        
        // Add text if item has text
        if (item.text) {
          textByPage[item.page] += item.text + " ";
        }
      }
    });
  });
}

async function testPDF(filePath) {
  try {
    console.log(`Testing PDF with pdfreader: ${filePath}`);
    
    if (!fs.existsSync(filePath)) {
      console.error("File not found");
      return;
    }
    
    const result = await parsePDF(filePath);
    console.log(`✅ Success! Pages: ${result.numPages}`);
    console.log(`Text length: ${result.text.length} chars`);
    console.log(`Preview: ${result.text.substring(0, 200)}...`);
    
  } catch (error) {
    console.error("❌ Failed:", error.message);
  }
}

testPDF("./test.pdf");