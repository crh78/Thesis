// Safari runs this on the page before the share sheet hands it to Thesis: the page's own title,
// any text you selected, and the article's text. Thesis reads these when a news site won't let
// its server fetch the page.
var Preprocess = function () {};

Preprocess.prototype = {
  run: function (args) {
    var selection = "";
    try { selection = String(window.getSelection ? window.getSelection() : ""); } catch (e) {}
    var article = document.querySelector("article") || document.querySelector("main") || document.body;
    var text = "";
    try { text = (article && article.innerText) || ""; } catch (e) {}
    args.completionFunction({
      url: document.URL,
      title: document.title,
      selection: selection.slice(0, 1500),
      text: text.slice(0, 4000),
    });
  },
};

var ExtensionPreprocessingJS = new Preprocess();
