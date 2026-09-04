class Header extends HTMLElement{
    constructor(){
        super();

        const loggedIn = typeof isLoggedIn === "function" ? isLoggedIn() : false;
        const currentUser = typeof getCurrentUser === "function" ? getCurrentUser() : null;

        const profileMenuItems = loggedIn
            ? `<li><span class="profile-username">Hi, ${currentUser}</span></li>
               <li><a href="./Spotify-songs/songs.html">Your Music</a></li>
               <li><a href="#" id="headerLogoutLink">Log out</a></li>`
            : `<li><a href="./login.html">Log In</a></li>`;

        const sidenavAuthItems = loggedIn
            ? `<li><a class="sidenav-link light">Hi, ${currentUser}</a></li>
               <li><a class="sidenav-link light son" href="#" id="sidenavLogoutLink">Logout</a></li>`
            : `<li><a class="sidenav-link light son" href="./login.html">Log In</a></li>`;

        this.innerHTML = `
		<header class="">
			<div class="container">
				<div class="header">
					<span class="logo">
						<a href="./index.html">
							<span class="app-brand"><img class="app-brand__icon" src="./assets/logo.png" alt="" /><span class="app-brand__text">Cloud Songs</span></span>
						</a>
					</span>
					<nav class="navigation">
						<ul>
							<li>
								<a class="navigation-link" href="./premium.html">Premium</a>
							</li>
							<li>
								<a class="navigation-link" href="./Spotify-songs/songs.html">Songs</a>
							</li>
							<li>
								<a class="navigation-link" href="./help.html">Help</a>
							</li>
							<li>
								<a class="navigation-link" href="./download.html">Download</a>
							</li>
							<li class="vertical_separator"></li>
							<li>
								<button class="profile_btn" type="button" onclick="profile()">
									<div class="usericon">
										<svg viewBox="0 0 1024 1024" aria-labelledby="mh-usericon-title">
											<title id="mh-usericon-title">Profil</title>
											<path d="M730.06 679.64q-45.377 53.444-101.84 83.443t-120 29.999q-64.032 0-120.75-30.503t-102.6-84.451q-40.335 13.109-77.645 29.747t-53.948 26.722l-17.142 10.084Q106.388 763.84 84.96 802.41t-21.428 73.107 25.461 59.242 60.754 24.705h716.95q35.293 0 60.754-24.705t25.461-59.242-21.428-72.603-51.679-57.225q-6.554-4.033-18.907-10.84t-51.427-24.453-79.409-30.755zm-221.84 25.72q-34.285 0-67.561-14.873t-60.754-40.335-51.175-60.502-40.083-75.124-25.461-84.451-9.075-87.728q0-64.032 19.915-116.22t54.452-85.964 80.67-51.931 99.072-18.151 99.072 18.151 80.67 51.931 54.452 85.964 19.915 116.22q0 65.04-20.167 130.58t-53.948 116.72-81.426 83.443-98.568 32.268z"></path>
										</svg>
									</div> 
									<div class="profile-title">
										<span>Profile</span> 
										<svg viewBox="0 0 1024 1024">
											<path d="M476.455 806.696L95.291 425.532Q80.67 410.911 80.67 390.239t14.621-34.789 35.293-14.117 34.789 14.117L508.219 698.8l349.4-349.4q14.621-14.117 35.293-14.117t34.789 14.117 14.117 34.789-14.117 34.789L546.537 800.142q-19.159 19.159-38.318 19.159t-31.764-12.605z"></path>
										</svg>
									</div>
								</button>
								<div id="profileMenu" class="profileMenu">
									<ul class="">
										${profileMenuItems}
									</ul>
								</div>
							</li>
						</ul>
					</nav>
					<div class="profile_icon-mobile">
						<div class="usericon">
							<a href="">
								<svg viewBox="0 0 1024 1024" aria-labelledby="mh-usericon-title">
									<title id="mh-usericon-title">Profil</title>
									<path d="M730.06 679.64q-45.377 53.444-101.84 83.443t-120 29.999q-64.032 0-120.75-30.503t-102.6-84.451q-40.335 13.109-77.645 29.747t-53.948 26.722l-17.142 10.084Q106.388 763.84 84.96 802.41t-21.428 73.107 25.461 59.242 60.754 24.705h716.95q35.293 0 60.754-24.705t25.461-59.242-21.428-72.603-51.679-57.225q-6.554-4.033-18.907-10.84t-51.427-24.453-79.409-30.755zm-221.84 25.72q-34.285 0-67.561-14.873t-60.754-40.335-51.175-60.502-40.083-75.124-25.461-84.451-9.075-87.728q0-64.032 19.915-116.22t54.452-85.964 80.67-51.931 99.072-18.151 99.072 18.151 80.67 51.931 54.452 85.964 19.915 116.22q0 65.04-20.167 130.58t-53.948 116.72-81.426 83.443-98.568 32.268z"></path>
								</svg>
							</a>
						</div> 
						<div class="container-togg" onclick="toggler(this)">
							<div class="bar1"></div>
							<div class="bar2"></div>
							<div class="bar3"></div>
						</div>
					</div>
				</div>
				<div id="mySidenav" class="sidenav">
					<ul>
						<li>
							<a class="sidenav-link" href="./premium.html">Premium</a>
						</li>
						<li>
							<a class="sidenav-link" href="./help.html">Help</a>
						</li>
						<li>
							<a class="sidenav-link" href="./download.html">Download</a>
						</li>
						<li class="h_separator"></li>
						${sidenavAuthItems}
					</ul>
					<span class="sidenav-logo">
						<a href="./index.html">
							<span class="app-brand"><img class="app-brand__icon" src="./assets/logo.png" alt="" /><span class="app-brand__text">Cloud Songs</span></span>
						</a>
					</span>
				</div>
			</div>
		</header>
        `;
    }

    connectedCallback() {
        const headerLogout = this.querySelector('#headerLogoutLink');
        const sidenavLogout = this.querySelector('#sidenavLogoutLink');
        const doLogout = (e) => {
            e.preventDefault();
            if (typeof logOut === 'function') {
                logOut();
            }
            window.location.href = './index.html';
        };
        if (headerLogout) headerLogout.addEventListener('click', doLogout);
        if (sidenavLogout) sidenavLogout.addEventListener('click', doLogout);
    }
}

window.customElements.define('custom-header', Header);