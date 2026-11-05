// L사 본사 근무일지 — PC판 실행 파일
// 옆의 www 폴더(게임 파일)를 이 컴퓨터 안에서만(127.0.0.1) 여는 작은 서버를 띄운 뒤 앱 창으로 연다.
// 기록은 창(브라우저 프로필)에 저장된다. 같은 주소(포트 고정)를 써야 기록이 이어지므로 포트를 바꾸지 않는다.
package main

import (
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"
)


const addr = "127.0.0.1:47811"
const url = "http://" + addr + "/"

var last atomic.Int64

func open() {
	dir := filepath.Join(os.Getenv("LOCALAPPDATA"), "LCorpWorklog")
	_ = os.MkdirAll(dir, 0755)
	args := []string{"--app=" + url, "--user-data-dir=" + dir, "--no-first-run", "--window-size=1366,860"}
	cands := []string{
		filepath.Join(os.Getenv("ProgramFiles(x86)"), `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(os.Getenv("ProgramFiles"), `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(os.Getenv("ProgramFiles"), `Google\Chrome\Application\chrome.exe`),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), `Google\Chrome\Application\chrome.exe`),
		filepath.Join(os.Getenv("LOCALAPPDATA"), `Google\Chrome\Application\chrome.exe`),
	}
	for _, c := range cands {
		if _, err := os.Stat(c); err == nil {
			if exec.Command(c, args...).Start() == nil {
				return
			}
		}
	}
	// Edge · Chrome이 없으면 기본 브라우저로
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = cmd.Start()
}

func main() {
	// 이미 켜져 있으면 창만 하나 더 연다
	if c, err := net.DialTimeout("tcp", addr, 300*time.Millisecond); err == nil {
		c.Close()
		open()
		return
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		open()
		return
	}
	// 게임 파일: 이 exe 옆의 www 폴더
	exe, _ := os.Executable()
	files := http.FileServer(http.Dir(filepath.Join(filepath.Dir(exe), "www")))
	last.Store(time.Now().Unix())
	mux := http.NewServeMux()
	mux.HandleFunc("/__alive", func(w http.ResponseWriter, r *http.Request) {
		last.Store(time.Now().Unix())
		w.Header().Set("Cache-Control", "no-store")
		w.Write([]byte("lcw"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		last.Store(time.Now().Unix())
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	})
	go func() {
		time.Sleep(400 * time.Millisecond)
		open()
	}()
	// 창을 모두 닫으면(신호가 2분 동안 없으면) 스스로 끝난다
	go func() {
		for {
			time.Sleep(15 * time.Second)
			if time.Now().Unix()-last.Load() > 120 {
				os.Exit(0)
			}
		}
	}()
	_ = http.Serve(ln, mux)
}
