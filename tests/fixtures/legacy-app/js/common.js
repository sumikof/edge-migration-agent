// Legacy helpers. NOTE: document.all is mentioned in this comment only.
var isIE = document.all ? true : false;

function addHandler(el, type, fn) {
  if (el.addEventListener) {
    el.addEventListener(type, fn, false);
  } else {
    el.attachEvent('on' + type, fn);
  }
}

function bindLegacy(el) {
  el.attachEvent('onclick', onLegacyClick);
}

function onLegacyClick() {
  var src = window.event.srcElement;
  window.event.returnValue = false;
  return src;
}

function enterToTab() {
  if (window.event.keyCode == 13) {
    window.event.keyCode = 9;
  }
}

function getXhr() {
  if (window.XMLHttpRequest) return new XMLHttpRequest();
  return new ActiveXObject("Microsoft.XMLHTTP");
}

function saveLocal(text) {
  var fso = new ActiveXObject("Scripting.FileSystemObject");
  fso.CreateTextFile("C:\\temp\\out.txt").Write(text);
}

function openPicker() {
  var result = window.showModalDialog("picker.html", window, "dialogWidth:400px");
  return result;
}

function sniff() {
  var label = "attachEvent is only a word in this string";
  if (navigator.userAgent.indexOf("MSIE") >= 0) return label;
  return navigator.appName;
}

function width(el) {
  return el.currentStyle.width;
}

document.domain = "example.local";
